<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CopyDocument, Document, Refresh } from '@element-plus/icons-vue'
import { configScriptApi } from '@/api/system'
import MonacoEditor from '@/components/MonacoEditor.vue'
import { copyText } from '@/utils/clipboard'

const content = ref('')
const savedContent = ref('')
const configPath = ref('config.sh')
const loading = ref(false)
const saving = ref(false)
const copying = ref(false)

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

        <!-- Monaco 初始化较重，等接口返回后再挂载，避免先闪一下空内容。 -->
        <!-- fill-height：桌面双栏下由 .config-layout → .editor-card → .el-card__body 的 flex 链撑满剩余高度；
             窄屏/移动端父级没有确定高度，改由本页 media query 给 560px 下限，行为与改造前一致。 -->
        <MonacoEditor
          v-if="!loading"
          v-model="content"
          language="shell"
          :fill-height="true"
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

// 直角卡：层次交给 1px 边框，不再用阴影浮起
.editor-card,
.info-card,
.tips-card {
  border-radius: 0;
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
  border-radius: 0;
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
  .editor-card :deep(.monaco-editor-wrapper) {
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
// 编辑器卡里装着 Monaco，both 会把 `transform: translateY(0)` 永久留在 .editor-card 上，
// 让它成为 Monaco 内部 position:fixed 浮层（右键菜单 / 补全 / 悬浮提示）的包含块 → 弹层错位，
// 与 ScriptExecutionDialogs.vue 里那条「不加 both」的注释是同一个坑。
// backwards 只在 delay 期间铺 from 帧，动画结束后回到自然样式（opacity 1、无 transform），
// 末态与 to 帧完全一致，视觉上没有区别。
// 只动 opacity + translateY、不碰 height：容器高度全程稳定，Monaco 的首次 layout 不受影响。
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
