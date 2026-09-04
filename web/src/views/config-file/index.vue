<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CopyDocument, Document, Refresh, Setting, Switch } from '@element-plus/icons-vue'
import { configScriptApi } from '@/api/system'
import CodeEditor, {
  persistEditorViewOption,
  persistEditorWordWrap,
  readStoredEditorViewOption,
  readStoredEditorWordWrap,
} from '@/components/CodeEditor.vue'
import type { EditorViewOption } from '@/components/CodeEditor.vue'
import { copyText } from '@/utils/clipboard'
import {
  persistEditorEngine,
  readStoredEditorEngine,
  resolveEditorEngine,
} from '@/utils/editorEngine'
import type { EditorEngine } from '@/utils/editorEngine'

const content = ref('')
const savedContent = ref('')
const configPath = ref('config.sh')
const loading = ref(false)
const saving = ref(false)
const copying = ref(false)

// 自动换行开关必须活在页面级 ref 里：下面的 CodeEditor 挂在 v-if="!loading" 上，
// 点一次「刷新」编辑器实例就整个重建，状态若只活在编辑器内部会被一起丢掉。
// 这份记忆与脚本页共享（同一个 dd:editor:word_wrap），所以读写走 CodeEditor 导出的那两个函数。
const wordWrap = ref(readStoredEditorWordWrap())

function toggleWordWrap() {
  wordWrap.value = wordWrap.value === 'on' ? 'off' : 'on'
  persistEditorWordWrap(wordWrap.value)
}

// 三个视图开关（缩略图 / 缩进参考线 / 空白符）与自动换行同源同命：
// 同样必须活在页面级 ref（编辑器挂在 v-if="!loading" 上，点刷新会整个重建），
// 同样与脚本页共享一份记忆，读写同样走 CodeEditor 的导出函数。
// 三项收在一个对象里按名字读写，避免写成三组雷同的 ref + toggle。
// 默认值（minimap/whitespace 关、indent_guides 开）由 CodeEditor 那两个函数负责，本页不复制一份。
const viewOptions = ref({
  minimap: readStoredEditorViewOption('minimap'),
  indent_guides: readStoredEditorViewOption('indent_guides'),
  whitespace: readStoredEditorViewOption('whitespace'),
})

function toggleViewOption(name: EditorViewOption) {
  const next = !viewOptions.value[name]
  viewOptions.value[name] = next
  persistEditorViewOption(name, next)
}

// 引擎偏好（auto / codemirror / monaco）：同样是「每浏览器一份、两页共享」，
// 也同样必须活在页面级 ref —— 编辑器挂在 v-if="!loading" 上，点一次刷新就整个重建。
// 但它**不是**视图开关那一档，菜单里用 divided 分开：
// 上面三项是「同一个编辑器怎么显示」，改一下只是重配一个 Compartment；
// 引擎是「换一个编辑器」，切一次要把实例整块拆掉重建，撤销历史、光标、滚动位置全丢
// （正文本身不丢，它活在本页的 content 里，重建后会重新灌进去）。
const editorEngine = ref(readStoredEditorEngine())

// 只做展示：告诉用户「自动」这一档在这台设备上落到哪个引擎，
// 否则选了 auto 的人完全看不出自己在用什么。
// 刻意不跟随窗口尺寸变化（resolveEditorEngine 内部读的是 window.innerWidth 快照）：
// auto 本来就只在编辑器挂载时解析一次，标签跟着拖窗口跳反而与实际用的引擎对不上。
const autoEngineLabel = computed(() =>
  resolveEditorEngine('auto') === 'monaco' ? 'Monaco' : 'CodeMirror',
)

function selectEditorEngine(next: EditorEngine) {
  if (editorEngine.value === next) return
  editorEngine.value = next
  persistEditorEngine(next) // 内部会派发 EDITOR_ENGINE_CHANGE_EVENT，已挂载的编辑器跟着换
}

// 本页被 keep-alive 缓存，第二次进来只触发 onActivated 不触发 onMounted。
// 不在这里补读一次的话，「在脚本页改了开关、切回本页却没变」——两页共享就名存实亡了。
// 三个视图开关同理，漏掉任何一个就是那一项单独失去共享（构建和类型检查都发现不了）。
onActivated(() => {
  wordWrap.value = readStoredEditorWordWrap()
  viewOptions.value = {
    minimap: readStoredEditorViewOption('minimap'),
    indent_guides: readStoredEditorViewOption('indent_guides'),
    whitespace: readStoredEditorViewOption('whitespace'),
  }
  // 引擎偏好同样两页共享，漏掉这一行的表现是「在脚本页切了引擎、切回本页菜单里还是旧的」——
  // 编辑器实例其实已经被 EDITOR_ENGINE_CHANGE_EVENT 换掉了，只有菜单勾选在骗人，
  // 比单纯不生效更难查。
  editorEngine.value = readStoredEditorEngine()
})

const hasChanged = computed(() => content.value !== savedContent.value)
const lineCount = computed(() => content.value === '' ? 0 : content.value.split(/\r\n|\n|\r/).length)
const byteSizeLabel = computed(() => {
  const bytes = new Blob([content.value]).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

onMounted(() => {
  void loadConfigScript()
})

async function loadConfigScript(showSuccess = false) {
  loading.value = true
  try {
    const res = await configScriptApi.get()
    content.value = res.content ?? ''
    savedContent.value = res.content ?? ''
    configPath.value = res.path || 'config.sh'
    if (showSuccess) {
      ElMessage.success('配置文件已刷新')
    }
  } catch {
    content.value = ''
    savedContent.value = ''
    ElMessage.error('加载配置文件失败')
  } finally {
    loading.value = false
  }
}

async function saveConfigScript() {
  saving.value = true
  try {
    await configScriptApi.save(content.value)
    savedContent.value = content.value
    ElMessage.success('配置文件已保存')
  } catch {
    ElMessage.error('保存配置文件失败')
  } finally {
    saving.value = false
  }
}

async function copyConfigScript() {
  copying.value = true
  try {
    await copyText(content.value)
    ElMessage.success('配置文件内容已复制')
  } catch {
    ElMessage.error('复制失败，请检查浏览器权限或站点访问方式')
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <div class="config-file-page dd-scroll-page dd-page-hide-heading">
    <div class="page-header">
      <div>
        <h2 class="page-title-with-icon">
          <el-icon><Document /></el-icon>
          <span>配置文件</span>
        </h2>
        <p class="page-subtitle">
          集中维护 <code>config.sh</code>，脚本运行前会自动加载这里的共享配置。
        </p>
      </div>
    </div>

    <div class="config-layout">
      <el-card class="editor-card" shadow="never" v-loading="loading">
        <template #header>
          <div class="editor-card__header">
            <div class="editor-card__intro">
              <div class="editor-card__title-row">
                <span class="editor-card__title">{{ configPath }}</span>
                <!--
                  保存状态是本页唯一的状态叙事，原来放在 .page-header 里，
                  而 .dd-page-hide-heading 把整个页头 display:none 了 —— 实际永远看不见。
                  这里挪到工具栏标题行；out-in 淡切的 key 必须绑「状态值」，
                  绑其它稳定值（如文件路径）永远不会触发过渡。
                -->
                <Transition name="dd-status-switch" mode="out-in">
                  <el-tag
                    :key="hasChanged ? 'changed' : 'saved'"
                    class="editor-card__status"
                    :type="hasChanged ? 'warning' : 'success'"
                    effect="plain"
                    size="small"
                  >
                    <el-icon v-if="!hasChanged"><Check /></el-icon>
                    {{ hasChanged ? '有未保存修改' : '已保存' }}
                  </el-tag>
                </Transition>
              </div>
              <div class="editor-card__desc">按 Shell 语法编辑，每行一个变量或注释。</div>
            </div>
            <div class="editor-card__actions">
              <!-- 状态类按钮排在动作类按钮之前。配色沿用本仓工具栏切换按钮的既有写法
                   （tasks 页快捷排序：开启时 primary + plain），不另造一套语汇；
                   与「保存」的实心 primary 靠 plain 区分，不会抢主操作的注意力。 -->
              <el-tooltip :content="wordWrap === 'on' ? '关闭自动换行' : '开启自动换行'" placement="bottom">
                <el-button
                  :type="wordWrap === 'on' ? 'primary' : 'default'"
                  :plain="wordWrap === 'on'"
                  @click="toggleWordWrap"
                >
                  <el-icon><Switch /></el-icon>
                  Wrap
                </el-button>
              </el-tooltip>
              <!-- 三个视图开关（缩略图 / 缩进参考线 / 空白符）收进齿轮下拉，与脚本页同一套交互。
                   本页工具栏虽然能换行（.editor-card__actions 带 flex-wrap，不像脚本页会被裁掉），
                   但三个开关并排就是三个按钮，窄屏必然把这一行折成三行；
                   而且两页的这组开关是同一份记忆，入口长得不一样只会让人以为是两套东西。
                   :hide-on-click="false"：三项经常连着切，点一下就收菜单会逼用户反复重开。 -->
              <el-dropdown trigger="click" placement="bottom-end" :hide-on-click="false">
                <el-button aria-label="编辑器选项">
                  <el-icon><Setting /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="toggleViewOption('minimap')">
                      <span class="opt-row">
                        <span>代码缩略图</span>
                        <span class="opt-state" :class="{ 'is-on': viewOptions.minimap }">{{ viewOptions.minimap ? 'ON' : 'OFF' }}</span>
                      </span>
                    </el-dropdown-item>
                    <el-dropdown-item @click="toggleViewOption('indent_guides')">
                      <span class="opt-row">
                        <span>缩进参考线</span>
                        <span class="opt-state" :class="{ 'is-on': viewOptions.indent_guides }">{{ viewOptions.indent_guides ? 'ON' : 'OFF' }}</span>
                      </span>
                    </el-dropdown-item>
                    <el-dropdown-item @click="toggleViewOption('whitespace')">
                      <span class="opt-row">
                        <span>显示空白符</span>
                        <span class="opt-state" :class="{ 'is-on': viewOptions.whitespace }">{{ viewOptions.whitespace ? 'ON' : 'OFF' }}</span>
                      </span>
                    </el-dropdown-item>

                    <!-- 引擎切换：用 divided 单独起一组，不和上面三项混排。
                         上面三项是「同一个编辑器怎么显示」，切一下只是重配一个 Compartment，代价为零；
                         引擎是「换一个编辑器」，切一次整块重建实例，撤销历史 / 光标 / 滚动位置全丢
                         （正文本身不丢，它活在本页的 content 里）。两者不是同一档，
                         并排放会让人以为引擎也是个随手可以来回拨的显示开关。

                         做成三项单选而不是一个「Monaco ON/OFF」开关：auto 既是默认值也是推荐值，
                         二值开关表达不了「跟着设备走」这个第三态，而这第三态正是
                         「触摸设备永远不给 Monaco」这条硬约束的落点 —— Monaco 是自绘编辑器，
                         长按系统菜单 / 选择手柄 / 拖动光标三条做不到，这也是当初换引擎的全部理由。

                         状态标写「当前」而不是沿用 ON/OFF：ON/OFF 是布尔读数，
                         放进三选一里会让人以为三个引擎能各自开关、甚至同时开着。
                         未选中的项不出标，三项里只有一枚标，「哪个在生效」一眼可读。

                         没有为这组新加按钮或另开一个「编辑器设置」入口：本页工具栏虽然能换行，
                         但脚本页的 .hero-actions 装不下就会被静默裁掉，两页入口必须长得一样；
                         何况同一页出现两个编辑器设置入口本身就是坏设计。 -->
                    <el-dropdown-item divided @click="selectEditorEngine('auto')">
                      <span class="opt-row">
                        <span>引擎：自动（{{ autoEngineLabel }}）</span>
                        <span v-if="editorEngine === 'auto'" class="opt-state is-on">当前</span>
                      </span>
                    </el-dropdown-item>
                    <el-dropdown-item @click="selectEditorEngine('codemirror')">
                      <span class="opt-row">
                        <span>引擎：CodeMirror</span>
                        <span v-if="editorEngine === 'codemirror'" class="opt-state is-on">当前</span>
                      </span>
                    </el-dropdown-item>
                    <el-dropdown-item @click="selectEditorEngine('monaco')">
                      <span class="opt-row">
                        <span>引擎：Monaco</span>
                        <span v-if="editorEngine === 'monaco'" class="opt-state is-on">当前</span>
                      </span>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button :loading="loading" @click="loadConfigScript(true)">
                <el-icon><Refresh /></el-icon>
                刷新
              </el-button>
              <el-button :loading="copying" @click="copyConfigScript">
                <el-icon><CopyDocument /></el-icon>
                复制
              </el-button>
              <el-button
                type="primary"
                :loading="saving"
                :disabled="loading || !hasChanged"
                @click="saveConfigScript"
              >
                保存
              </el-button>
            </div>
          </div>
        </template>

        <!-- 等接口返回后再挂载编辑器，避免先闪一下空内容。 -->
        <!-- fill-height：桌面双栏下由 .config-layout → .editor-card → .el-card__body 的 flex 链撑满剩余高度；
             窄屏/移动端父级没有确定高度，改由本页 media query 给 560px 下限，行为与改造前一致。 -->
        <CodeEditor
          v-if="!loading"
          v-model="content"
          language="shell"
          :fill-height="true"
          :word-wrap="wordWrap"
          :minimap="viewOptions.minimap"
          :indent-guides="viewOptions.indent_guides"
          :show-whitespace="viewOptions.whitespace"
        />
        <div v-else class="editor-placeholder">
          正在读取配置文件...
        </div>
      </el-card>

      <aside class="side-panel">
        <el-card class="info-card" shadow="never">
          <template #header>
            <span>文件说明</span>
          </template>
          <div class="info-list">
            <div class="info-row">
              <span>文件名</span>
              <code>{{ configPath }}</code>
            </div>
            <div class="info-row">
              <span>当前行数</span>
              <strong>{{ lineCount }}</strong>
            </div>
            <div class="info-row">
              <span>内容大小</span>
              <strong>{{ byteSizeLabel }}</strong>
            </div>
          </div>
        </el-card>

        <el-card class="tips-card" shadow="never">
          <template #header>
            <span>写法提示</span>
          </template>
          <ul class="tips-list">
            <li><code>KEY=VALUE</code>：写入普通变量。</li>
            <li><code>export KEY="VALUE"</code>：写入并导出变量。</li>
            <li><code>#</code> 开头表示注释，可记录用途。</li>
            <li>环境变量页面里的同名变量优先级更高。</li>
          </ul>
        </el-card>
      </aside>
    </div>
  </div>
</template>

<style scoped lang="scss">
.config-file-page {
  padding: 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;

  .page-title-with-icon {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--el-text-color-primary);
    line-height: 1.3;
  }

  .page-subtitle {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
}

.config-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

// 卡片：层次交给 1px 边框，不再用阴影浮起
.editor-card,
.info-card,
.tips-card {
  // 三张都是容器类表面 → surface 档
  // （.editor-card 还带 overflow: hidden，内部贴边的 header 与编辑器会被裁成同样的角）
  border-radius: var(--dd-radius-surface);
  border: 1px solid var(--el-border-color-lighter);
}

.editor-card {
  overflow: hidden;

  :deep(.el-card__header) {
    padding: 16px 18px;
  }

  :deep(.el-card__body) {
    padding: 0;
  }
}

.editor-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.editor-card__intro {
  min-width: 0;
}

.editor-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.editor-card__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

// 标签不参与压缩：窄屏由 .editor-card__title-row 的 flex-wrap 把它整体换行，
// 而不是把「有未保存修改」挤成半截
.editor-card__status {
  flex-shrink: 0;
}

// 「有未保存修改 ↔ 已保存」是本页唯一的状态叙事，切换时做一次极短的 out-in 淡切，
// 避免文案硬跳导致用户看不出状态变过。
// 只动 opacity：标签宽度在两个状态下不同，位移/缩放会让整行标题跟着晃。
.dd-status-switch-enter-active,
.dd-status-switch-leave-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-standard);
}

.dd-status-switch-enter-from,
.dd-status-switch-leave-to {
  opacity: 0;
}

.editor-card__desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.editor-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

// 齿轮下拉里的视图开关项：左侧标题、右侧一枚 ON/OFF 状态标。
// 下拉菜单项没有 EP 现成的选中态可用，只画一个对勾的话「没对勾」既可能是关、
// 也可能是没渲染上，读不出确定状态，所以两种状态都出字。
// 这两条与脚本页 ScriptsEditorPane.vue 里的同名规则是同一副长相：
// 两边都是 scoped 样式、隔着组件边界够不到对方，只能各写一份，要改就两边一起改。
.opt-row {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}

.opt-state {
  flex-shrink: 0;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  // 跟着它所在的下拉菜单项走 control 档（令牌表里「下拉/浮层菜单项」就是这一档）：
  // 菜单项是方角时里面嵌一颗胶囊会看出错位。它也不是状态灯（那类才走 pill 档），
  // 只是把开关状态写成字的静态读数。
  border-radius: var(--dd-radius-control);
  font-family: var(--dd-font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  // 关闭态用 regular 而不是更淡的 placeholder：这枚标是开关状态的唯一读数，
  // 10px 的小字再配 placeholder（明色下约 2.5:1）就没法读了，等于白做一个状态标。
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
  transition: background-color var(--dd-motion-fast) var(--dd-ease-standard),
    color var(--dd-motion-fast) var(--dd-ease-standard);

  &.is-on {
    color: var(--el-color-primary);
    background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  }
}

.editor-placeholder {
  min-height: 560px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  font-size: 14px;
}

.side-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-card,
.tips-card {
  :deep(.el-card__header) {
    padding: 14px 16px;
    font-weight: 700;
  }

  :deep(.el-card__body) {
    padding: 16px;
  }
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);

  code,
  strong {
    color: var(--el-text-color-primary);
    font-weight: 600;
  }
}

.tips-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.6;
}

code {
  padding: 1px 5px;
  // 行内代码底是文字里的小色块（不是块级代码面板）→ 归控件类 control 档
  border-radius: var(--dd-radius-control);
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
  font-family: var(--dd-font-mono);
  font-size: 12px;
}

// ===== 桌面双栏：整页固定高度，编辑器吃掉剩余高度 =====
// 只在双栏断点以上启用。1080px 以下是单栏（说明栏在编辑器下方），
// 固定高度反而会让编辑器和说明栏抢同一份垂直空间，保持原来的滚动布局更合适。
@media screen and (min-width: 1081px) {
  .config-file-page {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    // 覆盖 .dd-scroll-page 的 overflow: auto，滚动下沉到 .side-panel 内部
    overflow: hidden;
  }

  .page-header {
    flex-shrink: 0;
  }

  .config-layout {
    flex: 1 1 0;
    min-height: 0;
    // 单行 auto 轨道 + align-content 默认 stretch，行高会拉满容器
    align-items: stretch;
  }

  .editor-card {
    min-height: 0;
    display: flex;
    flex-direction: column;

    :deep(.el-card__header) {
      flex-shrink: 0;
    }

    :deep(.el-card__body) {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
  }

  .editor-placeholder {
    flex: 1 1 auto;
    min-height: 0;
  }

  // 说明栏内容很短，保持自然高度顶部对齐，不跟着拉成长条
  .side-panel {
    align-self: start;
    max-height: 100%;
    overflow: auto;
  }
}

@media (max-width: 1080px) {
  .config-layout {
    grid-template-columns: 1fr;
  }

  .side-panel {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  // 单栏/移动端父级高度不确定，fill-height 拿不到可撑满的高度，
  // 这里给回改造前的 560px 下限（选择器带 .editor-card，特异性高于组件内的默认规则）
  .editor-card :deep(.code-editor-wrapper) {
    min-height: 560px;
  }
}

@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
  }

  .editor-card__header,
  .editor-card__actions {
    align-items: stretch;
  }

  // 工具栏这一排现在是五个控件（Wrap / 齿轮 / 刷新 / 复制 / 保存）。
  // v3.2.2 加齿轮之前是四个，当年的结论「375px 及以上四个正好排得下一行」已经不成立，
  // 按同一套算法重推：
  //
  // ① 参与等分的只有 4 个。下面的 `.el-button { flex: 1 }` 是后代选择器，
  //    但 flex 只对**直接**子元素生效：`<el-tooltip>` 不产生额外 DOM 节点（Wrap 按钮本身就是 flex item），
  //    而 `<el-dropdown>` 会渲染一层 `div.el-dropdown` —— 那层 div 才是 flex item，选不到，
  //    于是齿轮不参与等分、保持内容宽度（纯图标约 44px）。这正是想要的：撑宽一个纯图标按钮没有意义，
  //    宽度应该留给带文字的四个。
  // ② 可用宽度 = 视口 375 − .layout-main 左右各 12 − .editor-card 边框各 1 − 卡片头左右各 18 ≈ 313px。
  //    扣掉齿轮 44px 和 4 个 8px 间隙，剩 ≈ 237px 给四个带文字的按钮等分，每个约 59px。
  // ③ `flex: 1` 展开是 `1 1 0%`，但 min-width 仍是 auto ——
  //    自动最小尺寸等于 min-content（左右内边距 + 图标 + 文字），
  //    带图标的两字按钮约 78px、Wrap 约 83px，都比等分得到的 59px 宽，压不下去
  //    （只有无图标的「保存」约 58px 压得住）。压不动就只能溢出或换行。
  // ④ 兜底的是 .editor-card__actions 自身的 flex-wrap：这一档实际是**折成两行**，不再是一行等分。
  //    按上面的估算断点大约落在「保存」之前（前四个一行、保存独占第二行并被 flex: 1 拉满），
  //    但这个切分随字体度量浮动，别当成保证；要保证的只有一条：无论怎么折都不会挤出横向滚动条。
  //
  // 三个视图开关之所以全塞进齿轮的下拉、而不是并排加三个按钮，就是为了这一档只多占约 44px。
  .editor-card__actions {
    width: 100%;

    .el-button {
      flex: 1;
    }
  }

  .side-panel {
    grid-template-columns: 1fr;
  }
}

// ===== 入场动画 =====
// 与全站 dd-*-rise-in 同一语汇：只对卡片级容器（编辑器卡 / 说明卡 / 提示卡）做淡入上移，
// ≤60ms 轻微错落；时长与缓动全部走令牌，prefers-reduced-motion 下令牌降为 1ms、
// delay 被全局补丁归零，等效关闭。
//
// fill-mode 用 backwards 而不是列表页惯用的 both：
// 编辑器卡里装着代码编辑器，both 会把 `transform: translateY(0)` 永久留在 .editor-card 上，
// 让它成为编辑器内部 position: fixed 浮层（搜索面板 / 补全 / 悬浮提示）的包含块 → 弹层错位，
// 与 ScriptExecutionDialogs.vue 里那条「不加 both」的注释是同一个坑。
// backwards 只在 delay 期间铺 from 帧，动画结束后回到自然样式（opacity 1、无 transform），
// 末态与 to 帧完全一致，视觉上没有区别。
// 只动 opacity + translateY、不碰 height：容器高度全程稳定，编辑器的首次布局不受影响。
@keyframes dd-configfile-rise-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.editor-card,
.info-card,
.tips-card {
  animation: dd-configfile-rise-in var(--dd-motion-page)
    var(--dd-ease-decelerate) backwards;
}

// 轻微错落：编辑器卡先入，右侧说明卡依次略晚
.info-card {
  animation-delay: 30ms;
}

.tips-card {
  animation-delay: 60ms;
}
</style>
