<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, computed, nextTick, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { logApi } from '@/api/log'
import { taskApi } from '@/api/task'
import { useAuthStore } from '@/stores/auth'
import { useBadgesStore } from '@/stores/badges'
import { ElMessage, ElMessageBox } from 'element-plus'
import { openAuthorizedEventStream, type EventStreamConnection } from '@/utils/sse'
import { usePageActivity } from '@/composables/usePageActivity'
import { useResponsive } from '@/composables/useResponsive'
import { extractError } from '@/utils/error'
import { canOperate } from '@/utils/roles'
import { formatDuration } from '@/utils/duration'
import { formatDateTime, toDateRangeParams } from '@/utils/datetime'
import { Download } from '@element-plus/icons-vue'
import DdDateRangePicker from '@/components/ui/DdDateRangePicker.vue'
import DdSplitButton from '@/components/ui/DdSplitButton.vue'
import type { SplitButtonItem } from '@/components/ui/DdSplitButton.vue'
import { createTerminalLineBuffer, TERMINAL_RENDER_CHUNK_SIZE, type TerminalLineBuffer } from '@/utils/ansi'
import { downloadTextAsFile, foldedLogDownloadName, startRawLogDownload } from '@/utils/rawLogDownload'

const route = useRoute()
const authStore = useAuthStore()
const badgesStore = useBadgesStore()
const logs = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const statusFilter = ref<string>('')
const keyword = ref('')
/**
 * 执行时间范围筛选。
 * 两端的时分秒由 toDateRangeParams 统一收拢到「起始日 00:00:00 ~ 结束日 23:59:59.999」，
 * 服务端按 created_at 闭区间过滤——与表格里那一列显示的字段是同一个，
 * 不会出现「列表写着 8-23，按 8-23 筛却少几条」。
 */
const dateRange = ref<[Date, Date] | null>(null)
const loading = ref(false)
const detailVisible = ref(false)
const detailLog = ref<any>(null)
const selectedIds = ref<number[]>([])
const selectedIdSet = computed(() => new Set(selectedIds.value))
const autoRefresh = ref(true)
const { isMobile, dialogFullscreen } = useResponsive()
const { isPageActive } = usePageActivity()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let logEventSource: EventStreamConnection | null = null
const logContentRef = ref<HTMLElement>()
let sseBuffer: string[] = []
let sseFlushRaf = 0

const showFileBrowser = ref(false)
const currentTaskId = ref<number>(0)
const logFiles = ref<any[]>([])
const logFilesLoading = ref(false)
const showFileContent = ref(false)
const fileContentName = ref('')
// 当前预览的日志文件，换「下载原始文件」票据时要用它的定位参数
const fileContentSource = ref<{ filename: string; path?: string } | null>(null)
const rawDownloading = ref(false)
const hasRunningLogs = computed(() => logs.value.some(l => l.status === 2))
const routeTaskId = ref<number | null>(null)
const pendingOpenTaskLog = ref(false)
const canOperateLogs = computed(() => canOperate(authStore.user?.role))

const allSelectedOnPage = computed(() => logs.value.length > 0 && logs.value.every(l => selectedIdSet.value.has(l.id)))
const someSelectedOnPage = computed(() => selectedIds.value.length > 0 && !allSelectedOnPage.value)

// 日志正文改成「按行 + 按块」增量渲染。
// 旧实现每次内容变化都要重跑 renderTerminalText + ansiToHtml + 整块 v-html 替换，
// 运行中任务的 SSE 流式追加下整体是 O(n²)；打开超大日志文件时也会长时间阻塞主线程。
// 行缓冲内部已经按终端语义处理 \n / \r\n / 裸 \r，并缓存每行的 HTML 与块 HTML。
const detailBuffer = createTerminalLineBuffer()
const detailRevision = ref(0)
const detailExpanded = ref(false)
const fileBuffer = createTerminalLineBuffer()
const fileRevision = ref(0)
const fileExpanded = ref(false)

// 渲染窗口封顶：默认只渲染最后 5000 行，避免超大日志把 DOM 撑爆
const RENDER_WINDOW_CHUNKS = 50
const MAX_RENDERED_LINES = RENDER_WINDOW_CHUNKS * TERMINAL_RENDER_CHUNK_SIZE

// 日志详情与日志文件预览共用同一套「分块 + 窗口封顶」派生逻辑。
// 行缓冲是普通对象，靠 revision 计数接进 Vue 的响应式。
function createTerminalView(buffer: TerminalLineBuffer, revision: Ref<number>, expanded: Ref<boolean>) {
  const renderWindow = computed(() => expanded.value ? 0 : RENDER_WINDOW_CHUNKS)
  return {
    hasContent: computed(() => {
      void revision.value
      return !buffer.isEmpty
    }),
    chunks: computed(() => {
      void revision.value
      return buffer.visibleChunks(renderWindow.value)
    }),
    omittedLines: computed(() => {
      void revision.value
      return buffer.omittedLineCount(renderWindow.value)
    }),
    pendingHtml: computed(() => {
      void revision.value
      return buffer.pendingLineHtml()
    }),
    lineCount: computed(() => {
      void revision.value
      return buffer.displayLineCount
    }),
    byteLabel: computed(() => {
      void revision.value
      const bytes = buffer.byteLength
      if (bytes === 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }),
  }
}

const {
  hasContent: detailHasContent,
  chunks: detailChunks,
  omittedLines: detailOmittedLines,
  pendingHtml: detailPendingHtml,
  lineCount: detailLineCount,
  byteLabel: detailByteLabel,
} = createTerminalView(detailBuffer, detailRevision, detailExpanded)

const {
  hasContent: fileHasContent,
  chunks: fileChunks,
  omittedLines: fileOmittedLines,
  pendingHtml: filePendingHtml,
} = createTerminalView(fileBuffer, fileRevision, fileExpanded)

function resetDetailBuffer() {
  detailBuffer.reset()
  detailExpanded.value = false
  detailRevision.value++
}

function expandDetailWindow() {
  const previousHeight = logContentRef.value?.scrollHeight ?? 0
  const previousTop = logContentRef.value?.scrollTop ?? 0
  detailExpanded.value = true
  void nextTick(() => {
    const el = logContentRef.value
    if (!el) return
    // 补齐的内容是往上长的，按高度差补偿滚动位置，避免视口整个跳走
    el.scrollTop = previousTop + (el.scrollHeight - previousHeight)
  })
}

let mounted = false

async function loadLogs() {
  loading.value = true
  selectedIds.value = []
  try {
    const params: any = { page: page.value, page_size: pageSize.value }
    if (routeTaskId.value) params.task_id = routeTaskId.value
    if (statusFilter.value !== '') params.status = statusFilter.value
    if (keyword.value) params.keyword = keyword.value
    Object.assign(params, toDateRangeParams(dateRange.value))
    const res = await logApi.list(params)
    logs.value = res.data
    total.value = res.total
    if (pendingOpenTaskLog.value) {
      pendingOpenTaskLog.value = false
      if (logs.value.length > 0) {
        void viewDetail(logs.value[0])
      }
    }
  } catch (err) {
    ElMessage.error(extractError(err, '加载日志失败'))
  } finally {
    loading.value = false
    syncAutoRefresh()
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer = setInterval(async () => {
    if (!isPageActive.value || !autoRefresh.value) {
      stopAutoRefresh()
      return
    }
    await loadLogs()
    if (!hasRunningLogs.value) {
      stopAutoRefresh()
    }
  }, 5000)
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

function syncAutoRefresh() {
  if (autoRefresh.value && hasRunningLogs.value && isPageActive.value) {
    if (!refreshTimer) {
      startAutoRefresh()
    }
    return
  }
  stopAutoRefresh()
}

watch([autoRefresh, hasRunningLogs, isPageActive], () => {
  syncAutoRefresh()
})

function syncTaskIdFromRoute(openLatest = false) {
  const taskId = Number(route.query.task_id)
  const nextTaskId = taskId > 0 ? taskId : null
  routeTaskId.value = nextTaskId
  pendingOpenTaskLog.value = openLatest && nextTaskId !== null
}

watch(
  () => route.query.task_id,
  () => {
    syncTaskIdFromRoute(true)
    page.value = 1
    void loadLogs()
  }
)

onMounted(async () => {
  mounted = true
  syncTaskIdFromRoute(true)
  // 进页即把侧栏的「失败日志」角标标记为已读——用户已经站在这一页上了，再红着没有意义
  badgesStore.ackLogsFailed()
  await loadLogs()
})

onActivated(() => {
  // 角标清零刻意放在下面那道 mounted 闸【外面】、且无条件执行：
  // 那道闸是给 loadLogs 防重复请求用的（onMounted 刚拉过一次），
  // 而 MainLayout 的 keep-alive 是 :max="14"，第二次以后进本页只触发 onActivated、
  // 不再触发 onMounted，写进 if 里就只有首次访问才会清零。
  badgesStore.ackLogsFailed()
  if (!mounted) {
    void loadLogs()
  }
  mounted = false
})

function handleSearch() {
  page.value = 1
  loadLogs()
}

function getStatusType(status: number | null) {
  if (status === 2) return 'warning'
  if (status === 3) return 'warning'
  if (status === 0) return 'success'
  if (status === 1) return 'danger'
  return 'info'
}

function getStatusText(status: number | null) {
  if (status === 2) return '运行中'
  if (status === 3) return '已终止'
  if (status === 0) return '成功'
  if (status === 1) return '失败'
  return '未知'
}

async function viewDetail(log: any) {
  detailLog.value = log
  resetDetailBuffer()
  detailVisible.value = true
  closeLogSSE()

  if (log.status === 2) {
    const url = `/api/v1/logs/${log.task_id}/stream`
    sseBuffer = []
    logEventSource = openAuthorizedEventStream(url, {
      onMessage(data) {
        sseBuffer.push(data)
        if (!sseFlushRaf) {
          sseFlushRaf = requestAnimationFrame(() => {
            for (const chunk of sseBuffer) {
              detailBuffer.append(chunk)
            }
            sseBuffer = []
            sseFlushRaf = 0
            // 整批只触发一次重渲染
            detailRevision.value++
            // 等 DOM 真正更新完再滚底，否则会停在这一帧之前的高度上
            void nextTick(() => {
              if (logContentRef.value) {
                logContentRef.value.scrollTop = logContentRef.value.scrollHeight
              }
            })
          })
        }
      },
      onEvent(event) {
        if (event.event === 'done') {
          closeLogSSE()
          loadLogs()
        }
      },
      onError() {
        closeLogSSE()
      }
    })
  } else {
    try {
      const res = await logApi.detail(log.id)
      detailLog.value = res
      resetDetailBuffer()
      detailBuffer.append(res.content || '(无日志内容)')
      detailRevision.value++
    } catch (err) {
      ElMessage.error(extractError(err, '获取日志详情失败'))
    }
  }
}

function closeLogSSE() {
  if (logEventSource) {
    logEventSource.close()
    logEventSource = null
  }
}

function downloadCurrentLog() {
  if (!detailHasContent.value) {
    ElMessage.warning('暂无内容可下载')
    return
  }
  const taskName = detailLog.value?.task_name || 'log'
  const logId = detailLog.value?.id ?? 'detail'
  const filename = `${taskName}-${logId}.log`.replace(/[\\/:*?"<>|]/g, '_')
  // 纯文本按需还原，不进渲染路径
  downloadTextAsFile(filename, detailBuffer.toText())
  ElMessage.success('已下载')
}

// 这条日志有没有磁盘上的原始文件。内容压缩后直接存库的短日志没有，此时不给下载入口。
const detailHasRawFile = computed(() => Boolean(detailLog.value?.log_path))

// 「下载原始日志」：服务端直接把磁盘文件流式吐给浏览器。
// 走浏览器原生下载而不是 axios blob —— 前端不缓存第二份全文，内存不翻倍。
async function downloadCurrentRawLog() {
  const logId = detailLog.value?.id
  if (!logId) {
    ElMessage.warning('暂无可下载的日志记录')
    return
  }
  if (rawDownloading.value) return

  rawDownloading.value = true
  try {
    startRawLogDownload(await logApi.rawDownloadTicket(logId))
  } catch (err) {
    ElMessage.error(extractError(err, '下载原始日志失败'))
  } finally {
    rawDownloading.value = false
  }
}

function downloadCurrentLogFile() {
  if (!fileHasContent.value) {
    ElMessage.warning('暂无内容可下载')
    return
  }
  downloadTextAsFile(foldedLogDownloadName(fileContentName.value), fileBuffer.toText())
  ElMessage.success('已下载')
}

async function downloadCurrentRawLogFile() {
  const source = fileContentSource.value
  if (!source) {
    ElMessage.warning('暂无可下载的日志文件')
    return
  }
  if (rawDownloading.value) return

  rawDownloading.value = true
  try {
    startRawLogDownload(await taskApi.logFileRawDownloadTicket(currentTaskId.value, source.filename, source.path))
  } catch (err) {
    ElMessage.error(extractError(err, '下载原始日志文件失败'))
  } finally {
    rawDownloading.value = false
  }
}

/**
 * 详情弹窗底部的「下载 ▾」菜单。
 *
 * 主体是 downloadCurrentLog（折叠后）——它对任何一条日志都可用，内容与页面所见一致，
 * 而且只落一份前端已有的文本，点错了代价最小。
 * 「下载原始日志」进菜单：它只对落盘的日志有效，且是服务端直传磁盘全文，
 * 误点可能凭空拉一个几百 MB 的下载。
 *
 * 不可用的原因原本写在按钮 title 里（要悬停才看得见），收进菜单后改写进 label——
 * 菜单项没有 title，禁用又不给理由等于没给。
 */
const detailDownloadItems = computed<SplitButtonItem[]>(() => [
  {
    key: 'raw',
    label: detailHasRawFile.value ? '下载原始日志' : '下载原始日志（无原始文件）',
    disabled: !detailHasRawFile.value || rawDownloading.value,
  },
])

function onDetailDownload(key: string) {
  if (key === 'raw') void downloadCurrentRawLog()
}

// 日志文件预览弹窗底部的「下载 ▾」，与详情弹窗同构：主体折叠后，原始字节进菜单
const fileDownloadItems = computed<SplitButtonItem[]>(() => [
  {
    key: 'raw',
    label: '下载原始文件',
    disabled: !fileContentSource.value || rawDownloading.value,
  },
])

function onFileDownload(key: string) {
  if (key === 'raw') void downloadCurrentRawLogFile()
}

async function copyCurrentLog() {
  if (!detailHasContent.value) {
    ElMessage.warning('暂无内容可复制')
    return
  }
  const text = detailBuffer.toText()
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); ElMessage.success('已复制到剪贴板') }
    catch { ElMessage.error('复制失败，请切换 HTTPS 或手动复制') }
    document.body.removeChild(ta)
  }
}

async function handleDelete(log: any) {
  if (!canOperateLogs.value) {
    ElMessage.warning('当前账号没有删除日志权限')
    return
  }
  try {
    await ElMessageBox.confirm('确定删除此日志记录？', '确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await logApi.delete(log.id)
    ElMessage.success('已删除')
    loadLogs()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

async function handleClean() {
  if (!canOperateLogs.value) {
    ElMessage.warning('当前账号没有清理日志权限')
    return
  }
  let daysInput: string
  try {
    const res = await ElMessageBox.prompt('请输入保留天数（将清理该天数之前的日志）', '清理日志', {
      inputValue: '7',
      inputPattern: /^[1-9]\d*$/,
      inputErrorMessage: '请输入正整数',
      confirmButtonText: '清理',
      cancelButtonText: '取消',
      type: 'warning',
    })
    daysInput = res.value
  } catch {
    return
  }
  const days = parseInt(daysInput, 10)
  try {
    const res = await logApi.clean(days)
    ElMessage.success(res.message)
    loadLogs()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '清理失败')
  }
}

function isSelected(id: number) {
  return selectedIdSet.value.has(id)
}

function toggleSelected(id: number, checked: boolean | string | number) {
  const next = new Set(selectedIds.value)
  if (checked) {
    next.add(id)
  } else {
    next.delete(id)
  }
  selectedIds.value = [...next]
}

function toggleSelectAll(checked: boolean | string | number) {
  if (checked) {
    selectedIds.value = logs.value.map(l => l.id)
  } else {
    selectedIds.value = []
  }
}

function clearSelection() {
  selectedIds.value = []
}

function handleSelectionChange(rows: any[]) {
  selectedIds.value = rows.map((r: any) => r.id)
}

async function handleBatchDelete() {
  if (!canOperateLogs.value) {
    ElMessage.warning('当前账号没有删除日志权限')
    return
  }
  if (selectedIds.value.length === 0) return
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${selectedIds.value.length} 条日志？`, '批量删除', { type: 'warning' })
    await logApi.batchDelete(selectedIds.value)
    ElMessage.success('批量删除成功')
    selectedIds.value = []
    loadLogs()
  } catch (err: any) {
    if (err !== 'cancel' && err?.toString() !== 'cancel') {
      ElMessage.error(err?.response?.data?.error || '批量删除失败')
    }
  }
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) {
    void loadLogs()
  } else {
    stopAutoRefresh()
  }
}

async function browseLogFiles(log: any) {
  currentTaskId.value = log.task_id
  logFiles.value = []
  showFileBrowser.value = true
  logFilesLoading.value = true
  try {
    const res = await taskApi.logFiles(log.task_id)
    logFiles.value = res || []
  } catch (err) {
    ElMessage.error(extractError(err, '获取日志文件列表失败'))
  } finally {
    logFilesLoading.value = false
  }
}

async function viewLogFile(file: any) {
  try {
    const res = await taskApi.logFileContent(currentTaskId.value, file.filename, file.path)
    fileBuffer.reset()
    fileExpanded.value = false
    fileBuffer.append(res.content || '(空文件)')
    fileRevision.value++
    fileContentName.value = file.filename
    fileContentSource.value = { filename: file.filename, path: file.path }
    showFileContent.value = true
  } catch (err) {
    ElMessage.error(extractError(err, '读取日志文件失败'))
  }
}

async function deleteLogFile(file: any) {
  if (!canOperateLogs.value) {
    ElMessage.warning('当前账号没有删除日志文件权限')
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除日志文件 ${file.filename}？`, '确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await taskApi.deleteLogFile(currentTaskId.value, file.filename, file.path)
    ElMessage.success('已删除')
    logFiles.value = logFiles.value.filter((f: any) => (f.path || f.filename) !== (file.path || file.filename))
  } catch (err) {
    ElMessage.error(extractError(err, '删除失败'))
  }
}

function formatFileSize(size: number) {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}

onBeforeUnmount(() => {
  stopAutoRefresh()
  closeLogSSE()
  if (sseFlushRaf) {
    cancelAnimationFrame(sseFlushRaf)
    sseFlushRaf = 0
  }
})
</script>

<template>
  <div class="logs-page dd-fixed-page dd-page-hide-heading">
    <!-- ======= Toolbar ======= -->
    <div class="toolbar">
      <!-- 左槽是【恒在】的容器，勾选时只切换它内部的内容：批量条原来挂在 toolbar__right 里，
           一出现就把整条工具栏顶成两行、表格跟着下移。
           mode="out-in" 保证同一时刻只有一个分支在 DOM 里，两者不会同时占位；
           容器自身的 flex 属性不变，右区也就不会因为 space-between 重新分配而横向滑走。 -->
      <div class="toolbar__left">
        <Transition name="dd-toolbar-swap" mode="out-in">
          <div v-if="canOperateLogs && selectedIds.length > 0" key="batch" class="batch-actions">
            <span class="batch-actions__count">已选 {{ selectedIds.length }} 项</span>
            <!-- 不写 size：与右区的「停止刷新 / 清理日志」同为 EP default 32px。
                 原来的 small 是 24px，两边差 8px，正是 issue 说的「高度不一致」。 -->
            <!-- 顺序与 tasks / envs 两页对齐：「批量删除」在前、「取消选择」殿后。
                 删除不放最右边缘，是因为那一侧最容易被甩动鼠标顺手点到，代价还不可逆；
                 让无害的「取消选择」去当边缘那一个。 -->
            <el-button type="danger" @click="handleBatchDelete">批量删除</el-button>
            <el-button @click="clearSelection">取消选择</el-button>
          </div>
          <div v-else key="filters" class="toolbar__filters">
            <div class="status-tabs">
              <button :class="['status-tab', { active: statusFilter === '' }]" @click="statusFilter = ''; handleSearch()">全部记录</button>
              <button :class="['status-tab', { active: statusFilter === '0' }]" @click="statusFilter = '0'; handleSearch()">成功</button>
              <button :class="['status-tab', { active: statusFilter === '1' }]" @click="statusFilter = '1'; handleSearch()">失败</button>
              <button :class="['status-tab', { active: statusFilter === '3' }]" @click="statusFilter = '3'; handleSearch()">已终止</button>
              <button :class="['status-tab', { active: statusFilter === '2' }]" @click="statusFilter = '2'; handleSearch()">运行中</button>
            </div>
            <el-input v-model="keyword" placeholder="搜索任务名称..." clearable class="toolbar__search" @keyup.enter="handleSearch" @clear="handleSearch">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <!-- 执行时间范围。inline 模式让快捷项与选择器同排，不把工具栏撑成两行。
                 disableFuture：日志是已经发生过的事，选到明天必然是空结果，
                 与其让用户以为筛选坏了，不如直接禁掉未来日期。 -->
            <DdDateRangePicker
              v-model="dateRange"
              inline
              size="default"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              @change="handleSearch"
            />
          </div>
        </Transition>
      </div>
      <div class="toolbar__right">
        <el-button
          :type="autoRefresh ? 'primary' : 'default'"
          @click="toggleAutoRefresh"
        >
          <el-icon><Refresh /></el-icon>
          <span>{{ autoRefresh ? '停止刷新' : '自动刷新' }}</span>
        </el-button>
        <el-button v-if="canOperateLogs" @click="handleClean">
          <el-icon><Delete /></el-icon>
          <span>清理日志</span>
        </el-button>
      </div>
    </div>

    <!-- ======= Mobile Card Layout ======= -->
    <div v-if="isMobile" class="dd-mobile-list" v-loading="loading">
      <div
        v-for="row in logs"
        :key="row.id"
        class="dd-mobile-card log-card"
      >
        <div class="dd-mobile-card__header">
          <div class="dd-mobile-card__title-wrap">
            <div class="dd-mobile-card__selection">
              <el-checkbox v-if="canOperateLogs" :model-value="isSelected(row.id)" @change="toggleSelected(row.id, $event)" />
              <span class="dd-mobile-card__title">{{ row.task_name || `任务#${row.task_id}` }}</span>
            </div>
            <!-- 与桌面表格同一处理。这里不能再套一层 span 包裹：
                 .dd-mobile-card__title-wrap 是纵向 flex 且 align-items 取默认 stretch，
                 el-tag 是直接子项才会被拉满整行宽；包一层会把它压回内容宽，白白改了版式。
                 Transition 自身不产生 DOM 节点，所以直接包住 el-tag 不影响这条继承关系。 -->
            <Transition name="dd-status-switch" mode="out-in">
              <el-tag :key="row.status" :type="getStatusType(row.status)" size="small" :class="row.status === 2 ? 'tag-with-dot' : ''">
                <span v-if="row.status === 2" class="pulse-dot"></span>
                {{ getStatusText(row.status) }}
              </el-tag>
            </Transition>
          </div>
        </div>

        <div class="dd-mobile-card__body">
          <div class="dd-mobile-card__grid">
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">耗时</span>
              <span class="dd-mobile-card__value">{{ formatDuration(row.duration) }}</span>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">开始时间</span>
              <span class="dd-mobile-card__value time-text">{{ formatDateTime(row.started_at) }}</span>
            </div>
            <div class="dd-mobile-card__field" v-if="row.ended_at">
              <span class="dd-mobile-card__label">结束时间</span>
              <span class="dd-mobile-card__value time-text">{{ formatDateTime(row.ended_at) }}</span>
            </div>
          </div>

          <div class="dd-mobile-card__actions">
            <el-button type="primary" size="small" @click="viewDetail(row)">查看日志</el-button>
            <el-button size="small" @click="browseLogFiles(row)">日志文件</el-button>
            <el-button v-if="canOperateLogs" size="small" type="danger" plain @click="handleDelete(row)">删除</el-button>
          </div>
        </div>
      </div>

      <el-empty v-if="!loading && logs.length === 0" description="暂无执行日志" />
    </div>

    <!-- ======= Desktop Table ======= -->
    <div v-else class="table-card">
      <el-table
        v-loading="loading"
        :data="logs"
        style="width: 100%"
        :header-cell-style="{ background: '#f8fafc', color: '#64748b', fontWeight: 600, fontSize: '13px' }"
        :row-style="{ cursor: 'pointer' }"
        @selection-change="handleSelectionChange"
        @row-click="viewDetail"
      >
        <el-table-column v-if="canOperateLogs" type="selection" width="40" />
        <el-table-column label="任务名称" min-width="200">
          <template #default="{ row }">
            <div class="task-name-cell">
              <div class="task-name-info">
                <span class="task-name-text">{{ row.task_name || `任务#${row.task_id}` }}</span>
                <span class="task-name-sub">#{{ row.id }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <!-- autoRefresh 每 5s 重拉一次列表，运行中→成功/失败 是硬切，眼睛捕捉不到「变了」。
                 out-in 让旧状态先淡出、新状态再淡入，给出一次明确的交接。
                 key 必须绑 row.status（状态值）——绑 row.id 的话同一行永远是同一个 key，
                 状态怎么变都不会触发过渡。
                 只做 opacity：表格行里任何位移都会连带整行一起抖。
                 out-in 的「移除旧节点 → 插入新节点」发生在同一次同步 patch 里，中间不会有一帧空布局，
                 所以不需要额外包一层占位容器来撑行高。 -->
            <Transition name="dd-status-switch" mode="out-in">
              <el-tag :key="row.status" :type="getStatusType(row.status)" size="small" round :class="row.status === 2 ? 'tag-with-dot' : ''">
                <span v-if="row.status === 2" class="pulse-dot"></span>
                {{ getStatusText(row.status) }}
              </el-tag>
            </Transition>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="100" align="center">
          <template #default="{ row }">
            <span class="time-text">{{ formatDuration(row.duration) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="执行时间" width="180" align="center">
          <template #default="{ row }">
            <span class="time-text">{{ formatDateTime(row.started_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right" align="center">
          <template #default="{ row }">
            <div class="action-btns">
              <el-button type="primary" text size="small" @click.stop="viewDetail(row)">查看</el-button>
              <el-button text size="small" @click.stop="browseLogFiles(row)">文件</el-button>
              <el-button v-if="canOperateLogs" type="danger" text size="small" @click.stop="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ======= Pagination ======= -->
    <div class="pagination-bar">
      <span class="pagination-total">共 {{ total }} 条数据</span>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        :layout="isMobile ? 'prev, pager, next' : 'sizes, prev, pager, next'"
        @current-change="loadLogs"
        @size-change="loadLogs"
      />
    </div>

    <!-- ======= Detail dialog ======= -->
    <el-dialog
      v-model="detailVisible"
      width="820px"
      top="6vh"
      align-center
      :fullscreen="dialogFullscreen"
      :show-close="false"
      :close-on-click-modal="false"
      class="log-detail-dialog"
      destroy-on-close
      @close="closeLogSSE"
    >
      <template #header>
        <div class="detail-hero">
          <div class="detail-hero-main">
            <div class="detail-hero-title-row">
              <span
                v-if="detailLog"
                class="status-indicator"
                :class="'status-indicator--' + getStatusType(detailLog.status)"
              >
                <span v-if="detailLog.status === 2" class="status-indicator-pulse"></span>
              </span>
              <span class="detail-hero-title">{{ detailLog?.task_name || '日志详情' }}</span>
              <span v-if="detailLog" class="detail-hero-id">#{{ detailLog.id }}</span>
              <span
                v-if="detailLog"
                class="log-row-status-label"
                :class="'log-row-status-label--' + getStatusType(detailLog.status)"
              >{{ getStatusText(detailLog.status) }}</span>
            </div>
            <div v-if="detailLog" class="detail-hero-meta">
              <span class="detail-hero-meta-item">耗时 {{ formatDuration(detailLog.duration) }}</span>
              <span class="detail-hero-meta-item">开始 {{ formatDateTime(detailLog.started_at) }}</span>
              <span class="detail-hero-meta-item" v-if="detailLog.ended_at">结束 {{ formatDateTime(detailLog.ended_at) }}</span>
            </div>
          </div>
          <button class="detail-hero-close" @click="detailVisible = false" aria-label="关闭">
            <el-icon :size="16"><Close /></el-icon>
          </button>
        </div>
      </template>

      <div class="detail-body">
        <div ref="logContentRef" class="detail-log dd-log-surface">
          <template v-if="detailHasContent">
            <button
              v-if="detailOmittedLines > 0"
              type="button"
              class="log-omitted-notice"
              title="超长日志默认只渲染末尾部分，避免页面卡顿。展开完整日志在内容极多时可能需要等待片刻，也可以直接用底部「下载」拿到全部内容。"
              @click="expandDetailWindow"
            >已省略前 {{ detailOmittedLines }} 行（默认只渲染最后 {{ MAX_RENDERED_LINES }} 行）· 点击展开完整日志</button>
            <span v-for="chunk in detailChunks" :key="chunk.key" v-html="chunk.html"></span>
            <span v-html="detailPendingHtml"></span>
          </template>
          <span v-else>（正在加载日志...）</span>
        </div>
        <div class="detail-status-bar">
          <div class="detail-status-group">
            <span class="detail-status-item">{{ detailLineCount }} 行</span>
            <span v-if="detailByteLabel" class="detail-status-item">{{ detailByteLabel }}</span>
          </div>
          <div class="detail-status-group">
            <span v-if="detailLog?.status === 2" class="detail-status-item detail-status-item--live">实时采集中</span>
            <span v-else class="detail-status-item">UTF-8</span>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="detail-footer">
          <el-button @click="copyCurrentLog" :disabled="!detailHasContent">
            <el-icon><DocumentCopy /></el-icon>
            <span>复制</span>
          </el-button>
          <!-- 原来「下载（折叠后）」与「下载原始日志」并排、同图标、同字号、都以「下载」开头，
               唯一的区别写在 title 里——不悬停就分不清，点错的概率极高。
               合成 Split Button：主体是折叠后（与页面所见一致、任何日志都可用），原始日志进菜单。
               整体 disabled 只在【两种都下不了】时才给：EP 的 split-button 会把主按钮和 caret
               一起禁用，若绑成 !detailHasContent，主体不可用时会连菜单里的原始日志一起塌掉。
               主体自身「无内容」的守卫本来就在 downloadCurrentLog 里，行为不变。
               placement 用 top-end：footer 贴着弹窗底边，往下弹必然触发 flip。 -->
          <DdSplitButton
            label="下载"
            type="default"
            size="default"
            :icon="Download"
            placement="top-end"
            :items="detailDownloadItems"
            :disabled="!detailHasContent && !detailHasRawFile"
            @click="downloadCurrentLog"
            @command="onDetailDownload"
          />
          <el-button type="primary" @click="detailVisible = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- ======= Log files dialog ======= -->
    <el-dialog
      v-model="showFileBrowser"
      title="日志文件"
      width="900px"
      :fullscreen="dialogFullscreen"
      class="log-files-dialog"
    >
      <el-table :data="logFiles" v-loading="logFilesLoading" max-height="420px" size="small">
        <el-table-column prop="filename" label="文件名" min-width="220" />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatFileSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" text size="small" @click="viewLogFile(row)">查看</el-button>
            <el-button v-if="canOperateLogs" type="danger" text size="small" @click="deleteLogFile(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!logFilesLoading && logFiles.length === 0" description="暂无日志文件" />
    </el-dialog>

    <el-dialog v-model="showFileContent" :title="fileContentName" width="1100px" :fullscreen="dialogFullscreen">
      <div class="detail-log dd-log-surface">
        <template v-if="fileHasContent">
          <button
            v-if="fileOmittedLines > 0"
            type="button"
            class="log-omitted-notice"
            title="超大日志文件默认只渲染末尾部分，避免页面卡顿。展开完整内容在文件很大时可能需要等待片刻。"
            @click="fileExpanded = true"
          >已省略前 {{ fileOmittedLines }} 行（默认只渲染最后 {{ MAX_RENDERED_LINES }} 行）· 点击展开完整内容</button>
          <span v-for="chunk in fileChunks" :key="chunk.key" v-html="chunk.html"></span>
          <span v-html="filePendingHtml"></span>
        </template>
        <span v-else>(空文件)</span>
      </div>

      <template #footer>
        <div class="detail-footer">
          <!-- 与详情弹窗同一处病灶：两个「下载…」并排。同样合成 Split Button，主体折叠后 -->
          <DdSplitButton
            label="下载"
            type="default"
            size="default"
            :icon="Download"
            placement="top-end"
            :items="fileDownloadItems"
            :disabled="!fileHasContent && !fileContentSource"
            @click="downloadCurrentLogFile"
            @command="onFileDownload"
          />
          <el-button type="primary" @click="showFileContent = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.logs-page {
  --logs-accent: #22c55e;
  --logs-border-soft: color-mix(in srgb, var(--el-border-color-light) 85%, transparent);
  --logs-surface: var(--el-bg-color);

  padding: 0;
  font-size: 14px;
}

/* =============== Page Header =============== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 18px;
  gap: 16px;

  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--el-text-color-primary);
    line-height: 1.3;
  }

  .page-subtitle {
    font-size: 13px;
    color: var(--el-text-color-secondary);
    margin: 4px 0 0;
  }

  .header-actions {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }
}

/* =============== Toolbar =============== */
// 工具条：与定时任务页对齐——上下统一间距、左右两区一行排布、gap 一致
.toolbar {
  display: flex;
  justify-content: space-between;
  // 刻意【不】用 align-items: center：左区被 630px 宽的日期选择器挤成两行（实测 88px）时，
  // center 会把只有 32px 高的右区整个垂直居中到 88px 的中线上，
  // 于是右侧按钮的中心比左侧 status-tabs 的中心低 22px（实测），正是 issue #103 说的「布局不一致」。
  // 改成 flex-start + 右区自己撑到 39px（= status-tabs 高度）并内部居中，
  // 两者就都对齐到左区【第一行】的中心线；左区只有一行时两边同为 39px，结果不变。
  align-items: flex-start;
  margin: 14px 0;
  gap: 12px;
  flex-wrap: wrap;

  // 左槽容器：勾选时内部在「筛选区」与「批量区」之间切换，容器本身恒在，flex 属性也恒定。
  // min-height 取 39px（status-tabs 实测高度）——批量按钮只有 32px，
  // 少了它工具栏会在切换的一瞬间塌 7px，表格跟着抖一下；
  // out-in 中途还有一帧容器为空，没有它会直接塌到 0。
  &__left {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    min-height: 39px;
  }

  // 筛选区：原来这几条挂在 __left 上，现在下沉一层，__left 只负责占位与对齐
  &__filters {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 10px;
    // 与左区第一行对齐的另一半：撑到同样的 39px，内部 center 让 32px 的按钮落在同一条中线上
    min-height: 39px;
  }

  &__search {
    width: 260px;
  }
}

// 状态分段控件：与定时任务页一致的直角分段容器；选中态靠底色+品牌色文字区分，不再用阴影浮起
.status-tabs {
  display: inline-flex;
  background: var(--el-fill-color-light);
  border-radius: 0;
  padding: 3px;
  gap: 2px;
}

.status-tab {
  padding: 6px 14px;
  border-radius: 0;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    color var(--dd-motion-fast) var(--dd-ease-standard),
    background-color var(--dd-motion-fast) var(--dd-ease-standard);
  white-space: nowrap;

  &:hover {
    color: var(--el-text-color-primary);
  }

  &.active {
    background: var(--el-bg-color);
    color: var(--el-color-primary);
    font-weight: 600;
  }
}

.batch-actions {
  display: flex;
  // 计数是纯文字、按钮是 32px 的实体块，不写 center 两者会按基线/拉伸排，文字看着往上飘
  align-items: center;
  gap: 8px;
}

// 勾选数：纯文字级提示，用次级色，不跟旁边那排实体按钮抢视觉重量
.batch-actions__count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  cursor: default;
}

// 左槽内容切换（筛选区 ⇄ 批量区）：只做 opacity，不做宽高。
// 尺寸过渡会让这条 flex-wrap 工具栏每帧重算换行，把整排按钮甩到第二行再甩回来，
// 还会一路推着表格与分页条重排，代价远大于收益。
// 时长走令牌，prefers-reduced-motion 下自动降为 1ms 即等效关闭。
.dd-toolbar-swap-enter-active,
.dd-toolbar-swap-leave-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-standard);
}

.dd-toolbar-swap-enter-from,
.dd-toolbar-swap-leave-to {
  opacity: 0;
}

// 状态 tag 的 out-in 交接。位移一律禁掉：
// 表格行内的 transform 会带着整行一起动，移动端卡片里则会顶动下面的字段网格。
.dd-status-switch-enter-active,
.dd-status-switch-leave-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-standard);
}

.dd-status-switch-enter-from,
.dd-status-switch-leave-to {
  opacity: 0;
}

/* =============== Table Card =============== */
// 表格卡：直角 + 1px 边框划分层次，不再用阴影浮起（dd-fixed-page 下的 flex + 内部滚动由全局规则接管）
.table-card {
  background: var(--el-bg-color);
  border-radius: 0;
  border: 1px solid var(--el-border-color-lighter);
  overflow: hidden;
}

.task-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-name-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.task-name-text {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.task-name-sub {
  font-size: 12px;
  font-family: var(--dd-font-mono);
  color: var(--el-text-color-placeholder);
}

.time-text {
  font-family: var(--dd-font-mono);
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.text-muted {
  color: var(--el-text-color-placeholder);
}

// 操作列：与定时任务页一致的轻量行内按钮组（去掉胶囊底/写死白色内阴影）
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;

  :deep(.el-button) {
    padding: 4px 8px;
  }

  // EP 自带 `.el-button + .el-button { margin-left: 12px }` 会叠加在上面的 flex gap 上，
  // 三个按钮凭空多吃 24px，一旦超过「操作」列的可用内容宽（列宽 − .cell 的 24px 内边距），
  // .cell 的 overflow:hidden 就变成可滚动容器：点右侧按钮时浏览器把它 scrollIntoView，
  // 整行左移、最左的按钮被裁掉，而且不会自动复位。间距统一交给 gap
  // （与 tasks / deps / subscriptions 三页一致）。
  :deep(.el-button + .el-button) {
    margin-left: 0;
  }
}

:deep(.tag-with-dot) {
  display: inline-flex !important;
  align-items: center;
  gap: 5px;
}

:deep(.el-table) {
  // 边框统一走令牌，明暗自动适配（原写死浅灰会在暗色串色）
  --el-table-border-color: var(--el-border-color-lighter);

  .el-table__header-wrapper th {
    border-bottom: 1px solid var(--el-border-color-light);
  }

  .el-table__row td {
    border-bottom: 1px solid var(--el-border-color-lighter);
    // 时长/缓动走令牌：原来写死的 0.18s ease 既不在动效档位上，
    // 也让这一页的行 hover 比全站其他表格慢半拍
    transition: background-color var(--dd-motion-fast) var(--dd-ease-standard);
  }

  .el-table__body tr:hover > td {
    background: var(--el-color-primary-light-9);
  }

  .el-table__cell {
    padding: 12px 0;
  }
}

/* =============== Pagination =============== */
// 分页条：与定时任务页一致的间距收敛
.pagination-bar {
  margin-top: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.pagination-total {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

// 状态点：直角小方块，去掉彩色光晕环，只保留纯色块
.status-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 0;
  display: inline-block;
  flex-shrink: 0;

  &--success { background: var(--logs-accent); }
  &--danger { background: var(--el-color-danger); }
  &--warning { background: var(--el-color-warning); }
  &--info { background: var(--el-text-color-placeholder); }
}

.status-indicator-pulse {
  position: absolute;
  inset: -3px;
  border-radius: 0;
  background: color-mix(in srgb, var(--el-color-warning) 50%, transparent);
  animation: orb-ripple 1.6s ease-out infinite;
}

.log-row-status-label {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  font-family: var(--dd-font-mono);
  border-radius: 0;

  &--success { background: color-mix(in srgb, var(--logs-accent) 14%, transparent); color: color-mix(in srgb, var(--logs-accent) 80%, var(--el-text-color-primary)); }
  &--danger { background: color-mix(in srgb, var(--el-color-danger) 14%, transparent); color: var(--el-color-danger); }
  &--warning { background: color-mix(in srgb, var(--el-color-warning) 14%, transparent); color: var(--el-color-warning); }
  &--info { background: var(--el-fill-color); color: var(--el-text-color-secondary); }
}

/* =============== Detail dialog =============== */
:deep(.log-detail-dialog) {
  border-radius: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  width: min(1400px, 92vw);
  height: clamp(680px, 85dvh, 920px);
  max-height: calc(100dvh - 64px);
  margin: auto;

  .el-dialog__header {
    padding: 0;
    margin: 0;
    border-bottom: 1px solid var(--logs-border-soft);
    flex-shrink: 0;
  }

  .el-dialog__body {
    padding: 0;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .el-dialog__footer {
    padding: 12px 18px;
    border-top: 1px solid var(--logs-border-soft);
    flex-shrink: 0;
  }
}

// 详情头部：纯色底，去掉渐变与右下角圆形光晕；与正文的分隔由 .el-dialog__header 的 1px 下边框承担
.detail-hero {
  display: flex;
  position: relative;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  background: var(--el-fill-color-lighter);
  overflow: hidden;
}

.detail-hero-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.detail-hero-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-hero-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-hero-id {
  font-family: var(--dd-font-mono);
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.detail-hero-meta {
  display: flex;
  gap: 16px;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  flex-wrap: wrap;
}

.detail-hero-meta-item {
  font-family: var(--dd-font-ui);
}

// 关闭按钮：直角方形，hover 只换底色/文字色，不做缩放、旋转与渐变辉光
.detail-hero-close {
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 0;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  transition:
    color var(--dd-motion-normal) var(--dd-ease-standard),
    background-color var(--dd-motion-normal) var(--dd-ease-standard),
    border-color var(--dd-motion-normal) var(--dd-ease-standard);

  .el-icon {
    position: relative;
    z-index: 1;
  }

  &:hover {
    color: #fff;
    background: var(--el-color-danger);
    border-color: var(--el-color-danger);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--el-color-danger) 60%, transparent);
    outline-offset: 2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .detail-hero-close {
    transition: none;
  }
}

.detail-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

// 正文容器用 div + white-space:pre-wrap 代替 <pre>：
// Vue 模板编译器会原样保留 <pre> 内部的缩进空白，而这里正文要拆成多个子节点分块渲染，
// 缩进会被当成正文渲染出来。等宽字体与换行语义都在这条规则里，视觉与原来的 <pre> 完全一致。
.detail-log {
  margin: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 22px;
  font-family: var(--dd-font-mono);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dd-log-text-color, #e2e8f0);
  border-radius: 0;
}

// 渲染窗口封顶提示：扁平直角虚线块，颜色全部从日志前景色派生，明暗两态自动适配
.log-omitted-notice {
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 6px 10px;
  border: 1px dashed color-mix(in srgb, var(--dd-log-text-color, #e2e8f0) 32%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--dd-log-text-color, #e2e8f0) 8%, transparent);
  color: color-mix(in srgb, var(--dd-log-text-color, #e2e8f0) 70%, transparent);
  font-family: var(--dd-font-mono);
  font-size: 11.5px;
  letter-spacing: 0.3px;
  text-align: left;
  white-space: normal;
  word-break: normal;
  cursor: pointer;
  transition:
    color var(--dd-motion-fast) var(--dd-ease-standard),
    background-color var(--dd-motion-fast) var(--dd-ease-standard),
    border-color var(--dd-motion-fast) var(--dd-ease-standard);

  &:hover {
    color: var(--dd-log-text-color, #e2e8f0);
    border-color: color-mix(in srgb, var(--dd-log-text-color, #e2e8f0) 52%, transparent);
    background: color-mix(in srgb, var(--dd-log-text-color, #e2e8f0) 14%, transparent);
  }
}

.detail-status-bar {
  display: flex;
  justify-content: space-between;
  padding: 6px 20px;
  font-family: var(--dd-font-mono);
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  border-top: 1px solid var(--logs-border-soft);
  background: color-mix(in srgb, var(--el-fill-color-lighter) 60%, transparent);
}

.detail-status-group {
  display: inline-flex;
  gap: 14px;
}

.detail-status-item--live {
  color: var(--el-color-warning);

  &::before {
    content: '● ';
    animation: pulse 1.6s ease-in-out infinite;
  }
}

.detail-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* =============== Animations =============== */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@keyframes orb-ripple {
  0% { transform: scale(0.65); opacity: 0.6; }
  100% { transform: scale(1.4); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .status-indicator-pulse,
  .detail-status-item--live::before { animation: none; }
}

/* =============== Mobile: 768px =============== */
@media screen and (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 14px;

    h2 { font-size: 18px; }

    .header-actions {
      width: 100%;
      flex-wrap: wrap;
    }
  }

  .toolbar {
    flex-direction: column;
    // 容器级 stretch 同时接管了桌面端的 align-items: flex-start：
    // 竖排时交叉轴是水平方向，左右两区都要铺满整行，不能收成内容宽
    align-items: stretch;
    gap: 10px;

    // 竖排改在筛选区上做。左槽保持横向单子项 + stretch，
    // 让唯一的子项（筛选区 / 批量区）撑满整行；若把 column 写在左槽上，
    // 它继承来的 align-items: center 会在竖排下把子项压回内容宽。
    &__left {
      align-items: stretch;
    }

    &__filters {
      flex-direction: column;
      gap: 10px;
    }

    &__search {
      width: 100% !important;
    }

    &__right {
      justify-content: stretch;
      flex-wrap: wrap;
    }

    &__right > * {
      flex: 1 1 calc(50% - 4px);
    }
  }

  .status-tabs {
    width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .batch-actions {
    flex-wrap: wrap;
    width: 100%;
  }

  .pagination-bar {
    flex-direction: column;
    gap: 10px;
    align-items: center;
  }

  .detail-hero {
    flex-direction: row;
    padding: 14px 16px;
  }

  .detail-hero-title { font-size: 15.5px; }
}

// ===== 入场动画 =====
// 与定时任务页统一：只对卡片级容器（工具条 / 表格卡 / 移动列表）做克制的淡入上移 + 轻微错落；
// 不给表格每一行或每张移动卡做 stagger。时长走令牌，prefers-reduced-motion 时令牌自动降为 1ms 即等效关闭。
@keyframes dd-logs-rise-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.toolbar,
.table-card,
.dd-mobile-list {
  animation: dd-logs-rise-in var(--dd-motion-page) var(--dd-ease-decelerate) both;
}

// 轻微错落：工具条先入，表格卡/移动列表略晚
.table-card,
.dd-mobile-list {
  animation-delay: 60ms;
}

</style>
