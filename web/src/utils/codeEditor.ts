import { EditorView } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import {
  getDefaultEditorBackgroundColor,
  getReadableTextColor,
  isDarkColor,
  isPanelDarkMode
} from './panelAppearance'

/**
 * CodeMirror 6 的语言支持与主题构建。
 *
 * 与被它取代的 utils/monaco.ts 最大的差别：**这里没有任何异步加载、资源探测或 CDN 兜底**。
 * CodeMirror 是普通 ES 模块，由 Vite 直接打进产物，import 完就能用；
 * 「本地资源残缺 → 回退 CDN → 超时 → 提示重试」那一整套故障模式在这个方案里不存在，
 * 所以调用点上的「加载中骨架 / 加载失败 + 重试按钮」也一并删掉了，不要再补回来。
 */

const EDITOR_BACKGROUND_VAR = '--dd-editor-bg-color'
const EDITOR_FOREGROUND_VAR = '--dd-editor-fg-color'

/** 等宽字体栈与环境变量弹窗里的那份保持一致，避免同一份脚本在两处字形不同。 */
const EDITOR_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

/**
 * 语言名 → CodeMirror 语言扩展。
 *
 * 语言名的真源是 `views/scripts/useScriptWorkspaceBrowser.ts` 的 editorLanguage 映射
 * （按扩展名推导），配置文件页固定传 'shell'，版本对比默认 'plaintext'。
 * 这里把真源里出现过的每一个值都覆盖到，并额外认几个常见别名（js/ts/sh/yml/md），
 * 免得将来在真源里加一行别名却忘了同步这边 —— 那种漏配的表现是「静默丢掉高亮」，不报错。
 *
 * plaintext（以及任何认不出来的值）返回空数组：CodeMirror 里「没有语言扩展」就是纯文本，
 * 不需要像 Monaco 那样有一个叫 plaintext 的语言。
 */
export function resolveCodeEditorLanguage(language?: string): Extension {
  switch ((language || '').trim().toLowerCase()) {
    case 'javascript':
    case 'js':
      return javascript()
    case 'typescript':
    case 'ts':
      // typescript 不是独立包，走 lang-javascript 的 typescript 选项
      return javascript({ typescript: true })
    case 'python':
    case 'py':
      return python()
    case 'shell':
    case 'bash':
    case 'sh':
      // shell 没有官方 lezer 语法，用 legacy-modes 的流式模式兜住（高亮质量略弱于 lezer，但覆盖到位）
      return StreamLanguage.define(shell)
    case 'go':
      return go()
    case 'json':
      return json()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'markdown':
    case 'md':
      return markdown()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'xml':
      return xml()
    default:
      return []
  }
}

/**
 * 语法高亮配色。
 *
 * 取值刻意贴近 Monaco 内置的 vs / vs-dark：改造前 `defineMonacoTheme` 的 rules 是空数组 + inherit，
 * 也就是语法色用的就是 Monaco 默认那套。老用户升级后代码的颜色基本不变，
 * 不会以为「换了引擎之后高亮坏了」。
 */
const DARK_SYNTAX = {
  comment: '#6a9955',
  keyword: '#569cd6',
  controlKeyword: '#c586c0',
  string: '#ce9178',
  number: '#b5cea8',
  typeName: '#4ec9b0',
  functionName: '#dcdcaa',
  variableName: '#9cdcfe',
  constant: '#4fc1ff',
  operator: '#d4d4d4',
  tagName: '#569cd6',
  attributeName: '#9cdcfe',
  regexp: '#d16969',
  meta: '#9e9e9e',
  invalid: '#f14c4c'
}

const LIGHT_SYNTAX = {
  comment: '#008000',
  keyword: '#0000ff',
  controlKeyword: '#af00db',
  string: '#a31515',
  number: '#098658',
  typeName: '#267f99',
  functionName: '#795e26',
  variableName: '#001080',
  constant: '#0070c1',
  operator: '#000000',
  tagName: '#800000',
  attributeName: '#e50000',
  regexp: '#811f3f',
  meta: '#808080',
  invalid: '#cd3131'
}

function buildHighlightStyle(dark: boolean) {
  const color = dark ? DARK_SYNTAX : LIGHT_SYNTAX

  // 同一个词命中多条规则时，lezer 按「标签更具体者胜」决定，与书写顺序无关，
  // 所以 function(variableName) 不会被下面那条裸 variableName 盖掉。
  return HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: color.comment, fontStyle: 'italic' },
    { tag: [tags.keyword, tags.modifier, tags.self, tags.null, tags.atom, tags.bool], color: color.keyword },
    { tag: [tags.controlKeyword, tags.moduleKeyword], color: color.controlKeyword },
    { tag: [tags.string, tags.special(tags.string), tags.character], color: color.string },
    { tag: [tags.number, tags.integer, tags.float], color: color.number },
    { tag: [tags.typeName, tags.className, tags.namespace], color: color.typeName },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: color.functionName },
    { tag: [tags.variableName, tags.propertyName, tags.labelName], color: color.variableName },
    { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: color.constant },
    { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.derefOperator], color: color.operator },
    { tag: [tags.tagName, tags.angleBracket], color: color.tagName },
    { tag: [tags.attributeName], color: color.attributeName },
    { tag: [tags.regexp, tags.escape], color: color.regexp },
    { tag: [tags.meta, tags.processingInstruction, tags.documentMeta], color: color.meta },
    { tag: [tags.heading], color: color.keyword, fontWeight: 'bold' },
    { tag: [tags.link, tags.url], color: color.constant, textDecoration: 'underline' },
    { tag: [tags.emphasis], fontStyle: 'italic' },
    { tag: [tags.strong], fontWeight: 'bold' },
    { tag: [tags.strikethrough], textDecoration: 'line-through' },
    { tag: [tags.invalid], color: color.invalid }
  ])
}

function readRootCssVar(name: string) {
  if (typeof window === 'undefined') {
    return ''
  }
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 按当前配色构建编辑器主题（外观 + 语法高亮）。
 *
 * 底色/前景色刻意写成 `var(--dd-editor-bg-color, <本次解析值>)` 而不是直接写死解析结果：
 * 这两条变量是**用户可配项**（系统设置里的 editor_background_color，由 utils/panelAppearance.ts
 * 写进 documentElement），写死会让用户自定义配色完全失效。
 * 写成 var() 之后，用户改色时连主题都不用重建，浏览器自己就重绘了。
 *
 * 但语法色 / 行号色 / 选区色只能在 JS 里按「底色是深是浅」二选一，没法用 var() 表达，
 * 所以调用方仍必须在 PANEL_APPEARANCE_CHANGE_EVENT（明暗切换也会走它，见 stores/theme.ts）
 * 触发时重新调本函数并通过 Compartment 换主题，否则浅色底上会留着深色主题的行号和选区。
 */
export function buildCodeEditorTheme(): Extension[] {
  const background =
    readRootCssVar(EDITOR_BACKGROUND_VAR) || getDefaultEditorBackgroundColor(isPanelDarkMode())
  const foreground = readRootCssVar(EDITOR_FOREGROUND_VAR) || getReadableTextColor(background)
  const dark = isDarkColor(background)

  const backgroundValue = `var(${EDITOR_BACKGROUND_VAR}, ${background})`
  const foregroundValue = `var(${EDITOR_FOREGROUND_VAR}, ${foreground})`
  // 选区/行高亮沿用改造前 defineMonacoTheme 里那几条颜色，保持观感一致
  const selectionColor = dark ? '#134e4acc' : '#bfdbfe'
  const activeLineColor = dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.04)'
  const gutterColor = dark ? '#6b7280' : '#94a3b8'
  const caretColor = dark ? '#34d399' : '#2563eb'
  const panelBorder = dark ? '#374151' : '#e2e8f0'

  // ⚠️ 下面每条后代选择器都刻意多写一个 `.cm-editor`（`&` 会被换成本主题的生成类名，
  // 于是变成 `.主题类.cm-editor .cm-xxx`，三个类）。
  // 理由：CodeMirror 的基础主题里有一批 `&light .cm-gutters` / `&dark .cm-activeLine` /
  // `&light .cm-panels` 这样的规则，展开后是「一个类 + 一个类」，和不加 `.cm-editor` 时
  // 我们写的规则**特异性完全相同**。同分时谁赢只取决于样式表注入顺序，
  // 而那取决于哪个编辑器先挂载 —— 赌输的表现是「深色编辑器配了一条浅灰行号栏」，
  // 而且只在某些进入顺序下复现。加一个类把这件事变确定。
  const theme = EditorView.theme(
    {
      // 刻意不在主题里写 height：普通编辑器要撑满外层容器、差异编辑器是左右两个编辑器并排，
      // 两边的高度策略不同，各自在组件的 scoped 样式里定，主题只管配色。
      '&': {
        color: foregroundValue,
        backgroundColor: backgroundValue
      },
      // CodeMirror 基础主题会在聚焦时画一圈点状 outline，Monaco 时代没有这个东西，去掉。
      // 聚焦与否靠原生光标就能看出来，不影响可访问性。
      '&.cm-focused': {
        outline: 'none'
      },
      '&.cm-editor .cm-scroller': {
        fontFamily: EDITOR_FONT_FAMILY,
        lineHeight: '1.5',
        overflow: 'auto'
      },
      '&.cm-editor .cm-content': {
        fontFamily: EDITOR_FONT_FAMILY,
        padding: '8px 0',
        // 原生光标的颜色：编辑器刻意没启用 drawSelection（那会关掉原生选区，
        // 手机上的长按菜单与选择手柄就全没了），所以只能靠 caret-color 给光标上色。
        caretColor
      },
      '&.cm-editor .cm-gutters': {
        backgroundColor: backgroundValue,
        color: gutterColor,
        border: 'none'
      },
      '&.cm-editor .cm-activeLine': {
        backgroundColor: activeLineColor
      },
      '&.cm-editor .cm-activeLineGutter': {
        backgroundColor: activeLineColor,
        color: foregroundValue
      },
      // 原生选区的配色。没启用 drawSelection，所以 .cm-selectionBackground 这里用不上。
      '&.cm-editor .cm-content ::selection': {
        backgroundColor: selectionColor
      },
      '&.cm-editor .cm-line::selection': {
        backgroundColor: selectionColor
      },
      '&.cm-editor .cm-selectionMatch': {
        backgroundColor: dark ? 'rgba(52, 211, 153, 0.18)' : 'rgba(37, 99, 235, 0.12)'
      },
      '&.cm-editor .cm-matchingBracket, &.cm-editor .cm-nonmatchingBracket': {
        backgroundColor: dark ? 'rgba(148, 163, 184, 0.28)' : 'rgba(100, 116, 139, 0.2)',
        outline: `1px solid ${gutterColor}`
      },
      '&.cm-editor .cm-searchMatch': {
        backgroundColor: dark ? 'rgba(234, 179, 8, 0.28)' : 'rgba(234, 179, 8, 0.35)'
      },
      '&.cm-editor .cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: dark ? 'rgba(234, 179, 8, 0.5)' : 'rgba(234, 179, 8, 0.6)'
      },
      // 搜索面板（Ctrl+F）用面板自身的令牌配色，不要跟着编辑器底色走：
      // 用户可能把编辑器底色调成任意颜色，面板控件仍要保持可读。
      '&.cm-editor .cm-panels': {
        backgroundColor: 'var(--el-bg-color)',
        color: 'var(--el-text-color-primary)',
        borderTop: `1px solid ${panelBorder}`,
        borderBottom: `1px solid ${panelBorder}`
      },
      '&.cm-editor .cm-textfield': {
        backgroundColor: 'var(--el-fill-color-blank)',
        color: 'var(--el-text-color-primary)',
        border: '1px solid var(--el-border-color)',
        borderRadius: 'var(--dd-radius-control)'
      },
      '&.cm-editor .cm-button': {
        backgroundColor: 'var(--el-fill-color-light)',
        backgroundImage: 'none',
        color: 'var(--el-text-color-primary)',
        border: '1px solid var(--el-border-color)',
        borderRadius: 'var(--dd-radius-control)'
      },
      '&.cm-editor .cm-specialChar': {
        color: dark ? '#f87171' : '#dc2626'
      }
    },
    { dark }
  )

  // dark 标志除了给我们自己用，@codemirror/merge 的内置差异配色也靠它区分明暗两套，
  // 传错了会出现「浅色底上一片深色的删除块」。
  return [theme, syntaxHighlighting(buildHighlightStyle(dark))]
}
