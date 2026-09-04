import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { PluginValue, ViewUpdate } from '@codemirror/view'
import { PANEL_APPEARANCE_CHANGE_EVENT } from './panelAppearance'

/**
 * 代码缩略图（右侧 minimap，issue #114-1）。
 *
 * ⚠️ 为什么是自己写的、而不是装 `@replit/codemirror-minimap`：
 * 那个包每一帧都往 `view.contentDOM` 里临时插一个 `div.cm-line` 量字体再删掉
 * （它自己的注释写着「TODO: … or get rid of it because it's slow」）。
 * CodeMirror 的 DOMObserver **只**监听 contentDOM，且 childList + subtree 全开，
 * 这种幽灵改动会被它读成一次真实 DOM 变更：
 *   readMutation → markDirty → DOMChange(domChanged=true) → applyDOMChange
 *   → 发现文本其实没变 → 强制 `view.update([])` → 把原生选区整个重写一遍。
 * 而「原生选区」正是 v3.2.0 换掉 Monaco 的**全部目的**（手机长按菜单 / 选择手柄 / 拖光标）。
 * 它还有两个硬伤：不支持自动换行（本组件默认就是开着的），以及只绑 mouse 事件、手机上拖不动。
 *
 * 所以本实现守三条铁律：
 *   1. DOM 全部挂在 `view.dom`（.cm-editor）下，**绝不碰 view.contentDOM**；
 *   2. `touch-action: none` 只加在缩略图自己身上，漏到 .cm-content / .cm-scroller
 *      就会废掉触摸滚动和拖光标；
 *   3. 几何全部走**像素**（contentHeight / lineBlockAtHeight），不走行数 ——
 *      走行数在自动换行和代码折叠下会和真实滚动位置对不上。
 */

/** 缩略图宽度（CSS px）。窄屏本来就不开，所以按桌面观感取值。 */
const MINIMAP_WIDTH = 64
/** 每一行在缩略图上占的高度 */
const BAND = 3
/** 每个源码字符在缩略图上占的宽度 */
const CHAR_W = 0.5
/** 正文块的不透明度：够看出代码形状，又不至于抢走正文的注意力 */
const BLOCK_ALPHA = 0.55

class MinimapPlugin implements PluginValue {
  private view: EditorView
  private root: HTMLDivElement
  private canvas: HTMLCanvasElement
  /** 视口指示框。滚动时只动它，不重绘 canvas。 */
  private box: HTMLDivElement
  private frame = 0
  private needsDraw = true
  /** 上一次绘制用的纵向比例，点击/拖动换算位置时要用同一个值 */
  private scale = 1

  constructor(view: EditorView) {
    this.view = view

    this.root = document.createElement('div')
    this.root.className = 'dd-minimap'
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'dd-minimap__canvas'
    this.box = document.createElement('div')
    this.box.className = 'dd-minimap__box'
    this.root.append(this.canvas, this.box)
    // 挂在 .cm-editor 上 —— 不是 contentDOM，也不是 scrollDOM（见文件头注释）
    view.dom.appendChild(this.root)

    // 指针事件一套覆盖鼠标 / 触摸 / 触控笔，且只绑在缩略图上
    this.root.addEventListener('pointerdown', this.onPointerDown)
    // 滚动只需要挪视口框，走原生 scroll 事件比等 ViewUpdate 跟手；passive 保证不挡触摸滚动
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    // 明暗切换 / 用户改编辑器底色都走这个事件，正文色变了就得重画
    window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, this.onAppearanceChange)

    this.schedule()
  }

  update(update: ViewUpdate) {
    // geometryChanged 覆盖了「编辑器容器尺寸变了」「字号变了」「折叠展开了」这几种
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.needsDraw = true
    }
    this.schedule()
  }

  destroy() {
    this.root.removeEventListener('pointerdown', this.onPointerDown)
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, this.onAppearanceChange)
    if (this.frame) cancelAnimationFrame(this.frame)
    this.root.remove()
  }

  private onAppearanceChange = () => {
    this.needsDraw = true
    this.schedule()
  }

  private onScroll = () => {
    this.schedule()
  }

  /** 一帧只做一次：连打字时不会把重绘排成队 */
  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      // 标志位由 draw() 自己在真正画完之后清，这里不碰：它有几条提前返回的分支
      if (this.needsDraw) this.draw()
      this.placeBox()
    })
  }

  /**
   * 纵向比例：缩略图上 1px 对应文档的多少 px。
   *
   * 取「自然比例」和「装得下的比例」里更小的那个：
   * 长文件按装得下压缩；短文件不放大 —— 否则 10 行的脚本会被拉成满屏 10 条细线加大片空隙。
   */
  private computeScale() {
    const mapHeight = this.view.dom.clientHeight
    const docHeight = Math.max(this.view.contentHeight, 1)
    const lineHeight = this.view.defaultLineHeight || 20
    return Math.min(BAND / lineHeight, mapHeight / docHeight)
  }

  private draw() {
    const { view, canvas } = this
    const mapHeight = view.dom.clientHeight
    // 刚挂载、外层 flex 还没定高的那一帧会走到这里；不清 needsDraw，理由见方法末尾
    if (mapHeight <= 0) return

    // 别硬编码 2 倍：1x 屏会白画一倍像素，3x 屏仍然糊
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(MINIMAP_WIDTH * dpr)
    canvas.height = Math.round(mapHeight * dpr)
    canvas.style.width = `${MINIMAP_WIDTH}px`
    canvas.style.height = `${mapHeight}px`

    const ctx = canvas.getContext('2d')
    // 同上：这一帧什么都没画出来，同样不能清 needsDraw
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 刻意只清空、不填背景：让用户自配的 --dd-editor-bg-color 原样透上来，
    // 填了底色就会在自定义底色下露出一块颜色不一样的矩形。
    ctx.clearRect(0, 0, MINIMAP_WIDTH, mapHeight)

    // 直接取正文的 computed color：它已经把 var(--dd-editor-fg-color, 兜底) 解析完了，
    // 明暗、用户自定义底色、自定义前景色三种情况一次覆盖，不用自己再判一遍深浅。
    ctx.fillStyle = window.getComputedStyle(view.contentDOM).color || '#888'
    ctx.globalAlpha = BLOCK_ALPHA

    this.scale = this.computeScale()
    const docHeight = Math.max(view.contentHeight, 1)
    const drawnHeight = Math.min(mapHeight, docHeight * this.scale)
    const bands = Math.ceil(drawnHeight / BAND)
    let lastLine = -1

    // 关键：按缩略图的「带」循环（几百次），不按文档行循环。
    // 5000 行和 50000 行的绘制成本完全一样。
    for (let b = 0; b < bands; b++) {
      const docY = (b * BAND) / this.scale
      // lineBlockAtHeight 是 O(log n)，而且天然感知自动换行与折叠
      const block = view.lineBlockAtHeight(Math.min(docY, docHeight - 1))
      const line = view.state.doc.lineAt(block.from)
      // 压缩比很高时相邻多条带会落到同一行，画一次就够
      if (line.number === lastLine) continue
      lastLine = line.number
      this.drawLine(ctx, line.text, b * BAND)
    }

    // ⚠️ 标志位只在这里清、不在 schedule() 的调用点清：上面两条提前返回意味着这一帧压根没画成，
    // 在外面无条件清掉就等于把这次重绘白丢了 —— 得等下一次 docChanged / viewportChanged /
    // geometryChanged 才补得回来。新加提前返回时同理，别顺手在返回前清。
    this.needsDraw = false
  }

  /** 把一行画成若干小方块：保留缩进留白，每段非空白 token 一个矩形 */
  private drawLine(ctx: CanvasRenderingContext2D, text: string, y: number) {
    const re = /\S+/g
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      const x = match.index * CHAR_W
      if (x >= MINIMAP_WIDTH) break
      const w = Math.min(match[0].length * CHAR_W, MINIMAP_WIDTH - x)
      ctx.fillRect(x, y, w, Math.max(BAND - 1, 1))
    }
  }

  /** 滚动时只走这里：两次 style 写入，零 canvas 开销 */
  private placeBox() {
    const { view, box } = this
    const mapHeight = view.dom.clientHeight
    if (mapHeight <= 0) return
    const { scrollTop, clientHeight } = view.scrollDOM
    box.style.top = `${scrollTop * this.scale}px`
    box.style.height = `${Math.max(clientHeight * this.scale, 4)}px`
  }

  private onPointerDown = (event: PointerEvent) => {
    // 手指/鼠标滑出缩略图也继续跟手
    this.root.setPointerCapture(event.pointerId)
    this.root.addEventListener('pointermove', this.onPointerMove)
    this.root.addEventListener('pointerup', this.onPointerUp)
    this.root.addEventListener('pointercancel', this.onPointerUp)
    this.jumpTo(event)
    // 只压缩略图自己的默认行为（选中、页面滚动），正文区一个字节都不碰
    event.preventDefault()
  }

  private onPointerMove = (event: PointerEvent) => {
    this.jumpTo(event)
  }

  private onPointerUp = (event: PointerEvent) => {
    if (this.root.hasPointerCapture(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId)
    }
    this.root.removeEventListener('pointermove', this.onPointerMove)
    this.root.removeEventListener('pointerup', this.onPointerUp)
    this.root.removeEventListener('pointercancel', this.onPointerUp)
  }

  /** 点到哪就把那一处滚到视口中间 */
  private jumpTo(event: PointerEvent) {
    const { view } = this
    const rect = this.root.getBoundingClientRect()
    const docY = (event.clientY - rect.top) / this.scale
    const scroller = view.scrollDOM
    const max = Math.max(scroller.scrollHeight - scroller.clientHeight, 0)
    scroller.scrollTop = Math.min(Math.max(docY - scroller.clientHeight / 2, 0), max)
    this.placeBox()
  }
}

export function codeMinimap(): Extension {
  return [
    ViewPlugin.fromClass(MinimapPlugin),
    EditorView.theme({
      // 缩略图是绝对定位、不占流，正文必须自己让出这一条，否则长行会钻到它下面
      '&.cm-editor .cm-scroller': {
        paddingRight: `${MINIMAP_WIDTH}px`
      },
      '&.cm-editor .dd-minimap': {
        position: 'absolute',
        top: '0',
        right: '0',
        bottom: '0',
        width: `${MINIMAP_WIDTH}px`,
        zIndex: '2',
        cursor: 'pointer',
        // ⚠️ 只在缩略图上。漏到 .cm-content 或 .cm-scroller 上，
        // 触摸滚动和「按住拖动光标」会当场全没。
        touchAction: 'none'
      },
      '&.cm-editor .dd-minimap__canvas': {
        display: 'block',
        pointerEvents: 'none'
      },
      // 视口指示框：用 currentColor 叠低透明度，明暗与用户自定义底色下都成立
      '&.cm-editor .dd-minimap__box': {
        position: 'absolute',
        left: '0',
        right: '0',
        backgroundColor: 'currentColor',
        opacity: '0.14',
        pointerEvents: 'none'
      }
    })
  ]
}

export { MINIMAP_WIDTH }
