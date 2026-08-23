<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { taskApi } from '@/api/task'
import { depsApi, type PythonRuntimeInfo } from '@/api/deps'
import { useAuthStore } from '@/stores/auth'
import { ElMessage, ElMessageBox } from 'element-plus'
import TaskForm from './components/TaskForm.vue'
import LogViewer from './components/LogViewer.vue'
import TaskDetail from './components/TaskDetail.vue'
import LogFileBrowser from './components/LogFileBrowser.vue'
import ViewManager from './components/ViewManager.vue'
import TaskCronList from './components/TaskCronList.vue'
import BatchAddLabelDialog from './components/BatchAddLabelDialog.vue'
import DdSplitButton from '@/components/ui/DdSplitButton.vue'
import type { SplitButtonItem } from '@/components/ui/DdSplitButton.vue'
import { getDisplayTaskLabels } from './taskLabels'
import { splitTaskCommandDisplay } from './taskCommand'
import { usePageActivity } from '@/composables/usePageActivity'
import { useResponsive } from '@/composables/useResponsive'
import { canOperate } from '@/utils/roles'
import { formatDuration } from '@/utils/duration'
import type { TaskViewFilter, TaskViewSortRule } from '@/api/taskView'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const { isMobile, width: viewportWidth } = useResponsive()
// 窄桌面：还没到移动端卡片布局，但表格已经装不下全部列。
// 1600 这个阈值来自实测：固定宽列合计 930px，加上三个弹性列的 min-width 230px 共 1160px，
// 再算上侧栏 218px 与 .layout-main 的左右 20px 内边距，窗口宽 <1600 时弹性列就开始被压到下限，
// 命令/标签/定时规则接连换行，行高从 ~50px 涨到 100~190px（1280×720 下只剩 3~4 行可见）。
// 典型受害者是 14 寸笔记本 1920×1080 + 150% 系统缩放 = 等效 1280×720。
const isNarrowDesktop = computed(() => !isMobile.value && viewportWidth.value < 1600)
const { isPageActive } = usePageActivity()
let statusTimer: ReturnType<typeof setInterval> | null = null

const TASK_PAGE_SIZE_STORAGE_KEY = 'dd:tasks:page_size'
const supportedTaskPageSizes = [10, 20, 50, 100]

function readStoredTaskPageSize() {
  if (typeof window === 'undefined') {
    return 20
  }

  const raw = window.localStorage.getItem(TASK_PAGE_SIZE_STORAGE_KEY)
  const parsed = Number(raw)
  return supportedTaskPageSizes.includes(parsed) ? parsed : 20
}

function persistTaskPageSize(value: number) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(TASK_PAGE_SIZE_STORAGE_KEY, String(value))
}

const tasks = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(readStoredTaskPageSize())
const keyword = ref('')
const statusFilter = ref<string>('')
const loading = ref(false)
const selectedIds = ref<number[]>([])
const selectedIdSet = computed(() => new Set(selectedIds.value))
const batchLabelVisible = ref(false)
// push_scope 由 GET /tasks/notification-channels 下发：'bound' 表示该渠道不参与广播，
// 任务不在表单里显式选中它，它就一条通知都收不到 —— 表单需要据此打标。
const notificationChannels = ref<{ id: number; name: string; type: string; enabled: boolean; push_scope?: string }[]>([])
const defaultPythonVersion = ref('3.12')
// 任务表单的 Python 版本候选：保留后端算好的 available/message，用于标注/禁用未安装版本
const pythonRuntimeOptions = ref<PythonRuntimeInfo[]>([])
const formVisible = ref(false)
const editingTask = ref<any>(null)
const prefillData = ref<any>(null)
const logViewerVisible = ref(false)
const logViewerTaskId = ref<number | null>(null)
const logViewerTaskName = ref('')
const logViewerMode = ref<'live' | 'latest'>('live')
const detailVisible = ref(false)
const detailTask = ref<any>(null)
const logFilesVisible = ref(false)
const logFilesTaskId = ref<number | null>(null)
const logFilesTaskName = ref('')
const viewFilters = ref<TaskViewFilter[]>([])
const viewSortRules = ref<TaskViewSortRule[]>([])
// 工具栏快捷排序：null 表示走后端默认排序（置顶+状态分组），非空时优先于视图自带排序
const quickSort = ref<{ field: string; direction: 'asc' | 'desc' } | null>(null)
const canOperateTasks = computed(() => canOperate(authStore.user?.role))
const canPollTaskStatus = computed(() => hasRunningTasks.value && isPageActive.value && selectedIds.value.length === 0)
const desktopTableHeight = computed(() => (isMobile.value ? undefined : '100%'))

function handleViewChange(filters: TaskViewFilter[], sortRules: TaskViewSortRule[]) {
  // 应用视图时清空快捷排序，避免与视图自带排序双重作用；视图自带排序优先
  quickSort.value = null
  viewFilters.value = filters
  viewSortRules.value = sortRules
  page.value = 1
  void loadTasks()
}

function getTaskTypeLabel(taskType: string | null | undefined) {
  if (taskType === 'manual') return '手动运行'
  if (taskType === 'startup') return '开机运行'
  return '常规定时'
}

function getCronExpressions(task: any) {
  if (Array.isArray(task?.cron_expressions) && task.cron_expressions.length > 0) {
    return task.cron_expressions
  }
  return String(task?.cron_expression || '')
    .split(/\r?\n/)
    .map((item: string) => item.trim())
    .filter(Boolean)
}

const hasRunningTasks = computed(() => tasks.value.some(t => t.status === 2))

// 快捷排序可选项：value 为 null 表示恢复默认排序，其余对应后端 sort_rules 的单条规则
const quickSortOptions: { key: string; label: string; value: { field: string; direction: 'asc' | 'desc' } | null }[] = [
  { key: 'default', label: '默认排序', value: null },
  { key: 'name_asc', label: '名称 A→Z', value: { field: 'name', direction: 'asc' } },
  { key: 'name_desc', label: '名称 Z→A', value: { field: 'name', direction: 'desc' } },
  { key: 'created_desc', label: '创建时间（最新优先）', value: { field: 'created_at', direction: 'desc' } },
  { key: 'created_asc', label: '创建时间（最早优先）', value: { field: 'created_at', direction: 'asc' } },
]

// 当前选中的快捷排序项 key，用于下拉菜单高亮；未选中（默认排序）时返回 'default'
const activeQuickSortKey = computed(() => {
  if (!quickSort.value) return 'default'
  const matched = quickSortOptions.find(
    opt => opt.value && opt.value.field === quickSort.value!.field && opt.value.direction === quickSort.value!.direction,
  )
  return matched ? matched.key : 'default'
})

// 排序按钮文案：默认显示「排序」，选中后体现当前排序，如「排序：创建时间 ↓」
const quickSortButtonText = computed(() => {
  if (!quickSort.value) return '排序'
  const arrow = quickSort.value.direction === 'asc' ? '↑' : '↓'
  const fieldText = quickSort.value.field === 'name' ? '名称' : '创建时间'
  return `排序：${fieldText} ${arrow}`
})

// 选择快捷排序项：重置到第一页并以现有加载逻辑刷新（与 handleSearch 同款）
function handleQuickSortSelect(value: { field: string; direction: 'asc' | 'desc' } | null) {
  quickSort.value = value
  page.value = 1
  void loadTasks()
}

watch(pageSize, (value) => {
  persistTaskPageSize(value)
})

watch(canPollTaskStatus, () => {
  syncStatusPolling()
})

function buildTaskListParams() {
  const params: Record<string, string | number> = {
    page: page.value,
    page_size: pageSize.value,
  }
  if (keyword.value) params.keyword = keyword.value
  if (statusFilter.value !== '') params.status = statusFilter.value
  if (viewFilters.value.length > 0) {
    params.filters = JSON.stringify(viewFilters.value)
  }
  // sort_rules 优先级：工具栏快捷排序 > 视图自带排序；默认排序（quickSort 为 null 且无视图排序）时不传，走后端默认置顶逻辑
  if (quickSort.value) {
    params.sort_rules = JSON.stringify([quickSort.value])
  } else if (viewSortRules.value.length > 0) {
    params.sort_rules = JSON.stringify(viewSortRules.value)
  }
  return params
}

function startStatusPolling() {
  stopStatusPolling()
  statusTimer = setInterval(async () => {
    if (!canPollTaskStatus.value) {
      stopStatusPolling()
      return
    }
    try {
      const res = await taskApi.list(buildTaskListParams())
      tasks.value = res.data
      total.value = res.total
      syncStatusPolling()
    } catch {}
  }, 3000)
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

function syncStatusPolling() {
  if (canPollTaskStatus.value) {
    if (!statusTimer) {
      startStatusPolling()
    }
    return
  }
  stopStatusPolling()
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await taskApi.list(buildTaskListParams())
    tasks.value = res.data
    total.value = res.total
    syncStatusPolling()
  } catch {
    ElMessage.error('加载任务列表失败')
  } finally {
    loading.value = false
  }
}

async function loadNotificationChannels() {
  try {
    const res = await taskApi.notificationChannels()
    notificationChannels.value = res.data || []
  } catch {
    notificationChannels.value = []
  }
}

async function loadDefaultPythonVersion() {
  try {
    const res = await depsApi.pythonRuntimes()
    // 保留后端已算好的 available/message，任务表单据此标注/禁用未安装版本并提示安装方式
    pythonRuntimeOptions.value = (res.data || [])
      .filter(item => ['3.10', '3.11', '3.12'].includes(item.version))
    if (['3.10', '3.11', '3.12'].includes(res.default_version)) {
      defaultPythonVersion.value = res.default_version
    }
  } catch {
    defaultPythonVersion.value = '3.12'
    pythonRuntimeOptions.value = []
  }
}

function clearTaskRouteQuery() {
  return router.replace({ path: '/tasks' })
}

async function handleRouteQueryAction() {
  if (route.query.create === '1') {
    if (!canOperateTasks.value) {
      ElMessage.warning('当前账号没有新建任务权限')
      await clearTaskRouteQuery()
      return
    }
    openCreate()
    await clearTaskRouteQuery()
    return
  }

  if (route.query.autoCreate === '1') {
    const name = route.query.name as string || ''
    const command = route.query.command as string || ''
    if (name && command) {
      if (!canOperateTasks.value) {
        ElMessage.warning('当前账号没有新建任务权限')
        await clearTaskRouteQuery()
        return
      }
      editingTask.value = null
      prefillData.value = { name, command, cron_expression: '0 0 * * *', task_type: 'cron' }
      formVisible.value = true
      await clearTaskRouteQuery()
    }
    return
  }

  const taskId = Number(route.query.task_id)
  if (taskId > 0 && route.query.action === 'run') {
    await clearTaskRouteQuery()
    if (!canOperateTasks.value) {
      ElMessage.warning('当前账号没有运行任务权限')
      return
    }
    const task = tasks.value.find(item => item.id === taskId) || { id: taskId, name: `任务#${taskId}`, status: 1 }
    await handleRun(task)
  }
}

let skipInitialActivated = true

onMounted(async () => {
  await Promise.all([loadTasks(), loadNotificationChannels(), loadDefaultPythonVersion()])
  await handleRouteQueryAction()
})

onActivated(async () => {
  if (skipInitialActivated) {
    skipInitialActivated = false
    return
  }
  await Promise.all([loadTasks(), loadNotificationChannels(), loadDefaultPythonVersion()])
  await handleRouteQueryAction()
})

onBeforeUnmount(() => {
  stopStatusPolling()
})

function handleSearch() {
  page.value = 1
  void loadTasks()
}

function getStatusType(status: number) {
  if (status === 0) return 'info'
  if (status === 0.5) return 'warning'
  if (status === 2) return 'warning'
  return 'success'
}

function getStatusText(status: number) {
  if (status === 0) return '禁用中'
  if (status === 0.5) return '排队中'
  if (status === 2) return '运行中'
  return '空闲中'
}

function formatTime(time: string | null) {
  if (!time) return '-'
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function navigateToScript(path: string) {
  router.push({ path: '/scripts', query: { file: path } })
}

function handlePageSizeChange() {
  page.value = 1
  void loadTasks()
}

function getRunStatusType(status: number | null) {
  if (status === null) return 'info'
  if (status === 0) return 'success'
  if (status === 2) return 'warning'
  return 'danger'
}

function getRunStatusText(status: number | null) {
  if (status === null) return '未运行'
  if (status === 0) return '成功'
  if (status === 2) return '已终止'
  return '失败'
}

function displayTaskLabels(task: any) {
  if (Array.isArray(task?.display_labels) && task.display_labels.length > 0) {
    return task.display_labels
  }
  return getDisplayTaskLabels(task?.labels || [])
}

function ensureCanOperate(message = '当前账号没有操作任务权限') {
  if (canOperateTasks.value) return true
  ElMessage.warning(message)
  return false
}

function openCreate() {
  if (!ensureCanOperate('当前账号没有新建任务权限')) return
  editingTask.value = null
  prefillData.value = null
  formVisible.value = true
}

function openEdit(task: any) {
  if (!ensureCanOperate('当前账号没有编辑任务权限')) return
  editingTask.value = task
  formVisible.value = true
}

function openDetail(task: any) {
  detailTask.value = task
  detailVisible.value = true
}

function openLogViewer(task: any) {
  logViewerTaskId.value = task.id
  logViewerTaskName.value = task.name
  logViewerMode.value = 'live'
  logViewerVisible.value = true
}

function openLogFiles(task: any) {
  logFilesTaskId.value = task.id
  logFilesTaskName.value = task.name
  logFilesVisible.value = true
}

async function handleFormSubmit(data: any) {
  if (!ensureCanOperate()) return
  try {
    if (editingTask.value) {
      await taskApi.update(editingTask.value.id, data)
      ElMessage.success('任务更新成功')
    } else {
      await taskApi.create(data)
      ElMessage.success('任务创建成功')
    }
    formVisible.value = false
    loadTasks()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

async function handleRun(task: any) {
  if (!ensureCanOperate('当前账号没有运行任务权限')) return
  try {
    await ElMessageBox.confirm(`确认运行定时任务「${task.name}」吗？`, '运行确认', { type: 'info' })
    await taskApi.run(task.id)
    ElMessage.success('任务已启动，正在打开实时日志')
    task.status = 2
    openLogViewer(task)
    syncStatusPolling()
    void loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err?.toString?.() === 'cancel') return
    ElMessage.error(err?.response?.data?.error || '启动失败')
  }
}

async function handleStop(task: any) {
  if (!ensureCanOperate('当前账号没有停止任务权限')) return
  try {
    await ElMessageBox.confirm(`确认停止定时任务「${task.name}」吗？`, '停止确认', { type: 'warning' })
    await taskApi.stop(task.id)
    ElMessage.success('任务已停止')
    task.status = 1
    loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err?.toString() === 'cancel') return
    ElMessage.error(err?.response?.data?.error || '停止失败')
  }
}

async function handleToggle(task: any) {
  if (!ensureCanOperate()) return
  try {
    if (task.status === 0) {
      await ElMessageBox.confirm(`确认启用定时任务「${task.name}」吗？`, '启用确认', { type: 'info' })
      const res = await taskApi.enable(task.id)
      ElMessage.success(res.message || '已启用')
    } else {
      const confirmMessage = task.status === 2
        ? `确认禁用定时任务「${task.name}」吗？当前执行不会被中断，禁用会在本次运行结束后生效。`
        : `确认禁用定时任务「${task.name}」吗？`
      await ElMessageBox.confirm(confirmMessage, '禁用确认', { type: 'warning' })
      const res = await taskApi.disable(task.id)
      ElMessage.success(res.message || (task.status === 2 ? '已设置为禁用，当前执行结束后生效' : '已禁用'))
    }
    loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err?.toString?.() === 'cancel') return
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

async function handleDelete(task: any) {
  if (!ensureCanOperate('当前账号没有删除任务权限')) return
  try {
    await ElMessageBox.confirm(`确定删除任务 "${task.name}"？`, '确认删除', { type: 'warning' })
    await taskApi.delete(task.id)
    ElMessage.success('任务已删除')
    loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err?.toString?.() === 'cancel') return
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

async function handleCopy(task: any) {
  if (!ensureCanOperate('当前账号没有复制任务权限')) return
  try {
    await taskApi.copy(task.id)
    ElMessage.success('任务已复制')
    loadTasks()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '复制失败')
  }
}

// 清除订阅锁：任务重新跟随订阅源，下次拉取会用订阅源的名称与定时覆盖回来，
// 所以这里必须二次确认，避免用户误点后手改的时间被打回。
async function handleRestoreSubscriptionDefault(task: any) {
  if (!task?.id) return
  if (!ensureCanOperate('当前账号没有编辑任务权限')) return
  try {
    await ElMessageBox.confirm(
      `任务「${task.name}」将重新跟随订阅源：下次拉取会用订阅源的名称与定时覆盖当前设置，订阅源删除脚本时也会自动删除该任务。确认恢复吗？`,
      '恢复为订阅默认',
      { type: 'warning' }
    )
    const res = await taskApi.restoreSubscriptionDefault(task.id)
    if (detailTask.value && detailTask.value.id === task.id) {
      detailTask.value = res.data
    }
    ElMessage.success('已恢复为订阅默认')
    loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.error || '恢复失败')
  }
}

async function handlePin(task: any) {
  if (!ensureCanOperate('当前账号没有置顶任务权限')) return
  try {
    if (task.is_pinned) {
      await taskApi.unpin(task.id)
    } else {
      await taskApi.pin(task.id)
    }
    loadTasks()
  } catch { /* ignore */ }
}

/**
 * 桌面表格「操作」列 Split Button 的菜单项。
 *
 * 按行生成而不是写成无参 computed：它要读 row.status / row.is_pinned，每行的结果都不一样。
 * 在模板里调用等于跑在渲染 effect 内，row 的响应式字段（handleRun 里会把 status 改成 2）
 * 与 canOperateTasks 都会被正常追踪。
 *
 * 「运行 / 停止」互斥且已由主体承担：空闲时主体是「运行」，运行中主体整个换成「停止」，
 * 所以这两项在菜单里【一个都不挂】——既不会出现「停止 ▾」里还有「停止」，
 * 也不会出现空闲状态下点得到「停止」。
 *
 * visible 兜的是权限：观察者（canOperateTasks=false）改造前顶层只有「实时日志」、
 * ⋯ 里只有「详情 / 日志文件」，这里必须一模一样。观察者那一支主体已经是「实时日志」，
 * 所以它在菜单里也要一起隐掉，否则同一个操作在一个按钮上出现两次。
 *
 * 「删除」不可撤销，只能待在菜单里，并且 danger + divided，绝不上主体。
 */
function taskActionItems(row: any): SplitButtonItem[] {
  const op = canOperateTasks.value
  return [
    { key: 'toggle', label: row.status === 0 ? '启用' : '禁用', visible: op },
    { key: 'liveLog', label: '实时日志', visible: op },
    { key: 'edit', label: '编辑', visible: op },
    { key: 'detail', label: '详情' },
    { key: 'logFiles', label: '日志文件' },
    { key: 'copy', label: '复制', visible: op },
    { key: 'pin', label: row.is_pinned ? '取消置顶' : '置顶', visible: op },
    { key: 'delete', label: '删除', danger: true, divided: true, visible: op },
  ]
}

// 只是把原来每个按钮的 @click 原样接过来，逻辑不动
function onTaskAction(key: string, row: any) {
  if (key === 'toggle') handleToggle(row)
  else if (key === 'liveLog') openLogViewer(row)
  else if (key === 'edit') openEdit(row)
  else if (key === 'detail') openDetail(row)
  else if (key === 'logFiles') openLogFiles(row)
  else if (key === 'copy') handleCopy(row)
  else if (key === 'pin') handlePin(row)
  else if (key === 'delete') handleDelete(row)
}

function handleSelectionChange(rows: any[]) {
  selectedIds.value = rows.map(r => r.id)
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

async function handleBatchAction(action: string) {
  if (!ensureCanOperate()) return
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先选择任务')
    return
  }
  const confirmMap: Record<string, { title: string; msg: string; type: 'warning' | 'info' }> = {
    delete: { title: '批量删除', msg: `确定删除选中的 ${selectedIds.value.length} 个任务？`, type: 'warning' },
    run: { title: '批量运行', msg: `确定运行选中的 ${selectedIds.value.length} 个任务？`, type: 'info' },
    enable: { title: '批量启用', msg: `确定启用选中的 ${selectedIds.value.length} 个任务？`, type: 'info' },
    disable: { title: '批量禁用', msg: `确定禁用选中的 ${selectedIds.value.length} 个任务？`, type: 'warning' },
    stop: { title: '批量停止', msg: `确定停止选中的 ${selectedIds.value.length} 个任务？`, type: 'warning' },
  }
  const confirm = confirmMap[action]
  if (confirm) {
    await ElMessageBox.confirm(confirm.msg, confirm.title, { type: confirm.type })
  }
  try {
    await taskApi.batch(selectedIds.value, action)
    ElMessage.success('操作成功')
    loadTasks()
  } catch (err: any) {
    if (err === 'cancel' || err?.toString() === 'cancel') return
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

function openBatchAddLabel() {
  if (!ensureCanOperate()) return
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先选择任务')
    return
  }
  batchLabelVisible.value = true
}

function handleBatchLabelSuccess() {
  selectedIds.value = []
  loadTasks()
}

async function handleBatchPin() {
  if (!ensureCanOperate('当前账号没有置顶任务权限')) return
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先选择任务')
    return
  }
  // 并发发送，单条失败不阻塞其他任务
  const results = await Promise.allSettled(selectedIds.value.map(id => taskApi.pin(id)))
  const failed = results.filter(r => r.status === 'rejected')
  if (failed.length === 0) {
    ElMessage.success(`批量置顶成功（${results.length} 个）`)
  } else if (failed.length === results.length) {
    const first = failed[0] as PromiseRejectedResult
    ElMessage.error((first.reason as any)?.response?.data?.error || '批量置顶全部失败')
  } else {
    ElMessage.warning(`已置顶 ${results.length - failed.length} 个，${failed.length} 个失败`)
  }
  loadTasks()
}

async function handleCleanLogs() {
  if (!ensureCanOperate('当前账号没有清理日志权限')) return
  let daysStr: string
  try {
    const { value } = await ElMessageBox.prompt('清理多少天前的日志？', '日志清理', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入有效的天数',
      inputValue: '30',
    })
    daysStr = value
  } catch {
    return
  }
  try {
    await taskApi.cleanLogs(Number(daysStr))
    ElMessage.success('日志清理成功')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '日志清理失败')
  }
}

async function handleExport() {
  try {
    const res = await taskApi.export()
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tasks_export_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '导出失败')
  }
}

const importFileRef = ref<HTMLInputElement>()

function triggerImport() {
  if (!ensureCanOperate('当前账号没有导入任务权限')) return
  importFileRef.value?.click()
}

async function handleImport(event: Event) {
  if (!ensureCanOperate('当前账号没有导入任务权限')) return
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch (e: any) {
      ElMessage.error(`JSON 解析失败：${e?.message || '文件格式错误'}`)
      return
    }
    const tasksData = Array.isArray(data) ? data : data.data || data.tasks
    if (!Array.isArray(tasksData)) {
      ElMessage.error('导入数据结构无效：期望数组或 {data: [...]} / {tasks: [...]}')
      return
    }
    const invalid = tasksData.find(t => !t || typeof t !== 'object' || !t.name)
    if (invalid) {
      ElMessage.error('导入数据中存在缺少 name 字段的任务')
      return
    }
    const res = await taskApi.import(tasksData)
    ElMessage.success(res.message)
    if (res.errors?.length) {
      ElMessage.warning(`${res.errors.length} 个导入错误`)
    }
    loadTasks()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || '导入失败')
  }
  (event.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="tasks-page dd-fixed-page dd-page-hide-heading">
    <ViewManager @view-change="handleViewChange" />

    <div class="toolbar">
      <div class="toolbar__left">
        <div class="status-tabs">
          <button :class="['status-tab', { active: statusFilter === '' }]" @click="statusFilter = ''; handleSearch()">全部任务</button>
          <button :class="['status-tab', { active: statusFilter === '2' }]" @click="statusFilter = '2'; handleSearch()">运行中</button>
          <button :class="['status-tab', { active: statusFilter === '0' }]" @click="statusFilter = '0'; handleSearch()">已禁用</button>
          <button :class="['status-tab', { active: statusFilter === '1' }]" @click="statusFilter = '1'; handleSearch()">已启用</button>
        </div>
        <el-input v-model="keyword" placeholder="搜索任务名称/命令" clearable class="toolbar__search" @keyup.enter="handleSearch" @clear="handleSearch">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
      <div class="toolbar__right">
        <el-dropdown trigger="click" class="sort-dropdown">
          <el-button :type="quickSort ? 'primary' : 'default'" :plain="!!quickSort">
            <el-icon><Sort /></el-icon>
            <span class="sort-dropdown__text">{{ quickSortButtonText }}</span>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="option in quickSortOptions"
                :key="option.key"
                @click="handleQuickSortSelect(option.value)"
              >
                <!-- 选中项用左侧 Check 图标 + 品牌色高亮（下拉菜单 teleport 到 body，故用内联色保证生效） -->
                <el-icon
                  v-if="activeQuickSortKey === option.key"
                  style="margin-right: 6px; color: var(--el-color-primary);"
                ><Check /></el-icon>
                <span v-else style="display: inline-block; width: 20px;"></span>
                <span :style="activeQuickSortKey === option.key ? 'color: var(--el-color-primary); font-weight: 600;' : ''">
                  {{ option.label }}
                </span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown trigger="click">
          <el-button><el-icon><More /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="handleExport">导出任务</el-dropdown-item>
              <el-dropdown-item v-if="canOperateTasks" @click="triggerImport">导入任务</el-dropdown-item>
              <el-dropdown-item v-if="canOperateTasks" divided @click="handleCleanLogs">清理日志</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <input ref="importFileRef" type="file" accept=".json" style="display:none" @change="handleImport" />
        <!-- 勾选第一行时这七个按钮凭空插进工具栏右区，会把「新建任务」整个推走、看着像抖了一下。
             淡入淡出让它有个出现/消失的过程，位置变化就不再显得是闪现。
             只做 opacity：宽度/高度动画会让 .toolbar 每一帧重新算换行，整页跟着重排。
             （淡出期间元素仍占位，所以按钮消失时右区只重排一次，这是 opacity 方案的固有代价，
             比逐帧重排划算得多。） -->
        <Transition name="dd-batch-actions">
          <div v-if="canOperateTasks && selectedIds.length > 0" class="batch-actions">
            <el-button size="small" @click="handleBatchAction('enable')">批量启用</el-button>
            <el-button size="small" @click="handleBatchAction('disable')">批量禁用</el-button>
            <el-button size="small" @click="handleBatchAction('run')">批量运行</el-button>
            <el-button size="small" type="warning" plain @click="handleBatchAction('stop')">批量停止</el-button>
            <el-button size="small" @click="openBatchAddLabel">添加标签</el-button>
            <el-button size="small" @click="handleBatchPin">批量置顶</el-button>
            <el-button size="small" type="danger" @click="handleBatchAction('delete')">批量删除</el-button>
          </div>
        </Transition>
        <el-button v-if="canOperateTasks" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon> 新建任务
        </el-button>
      </div>
    </div>

    <div v-if="isMobile" class="dd-mobile-list">
      <div
        v-for="row in tasks"
        :key="row.id"
        class="dd-mobile-card task-card"
      >
        <div class="dd-mobile-card__header">
          <div class="dd-mobile-card__title-wrap task-card__title-wrap">
            <div class="task-card__title-row">
              <div class="dd-mobile-card__selection">
                <el-checkbox v-if="canOperateTasks" :model-value="isSelected(row.id)" @change="toggleSelected(row.id, $event)" />
                <div class="task-card__name-block">
                  <div class="task-card__name-line">
                    <el-icon v-if="row.is_pinned" class="pin-icon" :class="{ 'is-readonly': !canOperateTasks }" @click="canOperateTasks && handlePin(row)"><Star /></el-icon>
                    <button
                      type="button"
                      class="dd-mobile-card__title task-name-link"
                      :title="`查看 ${row.name} 的日志文件`"
                      @click.stop="openLogFiles(row)"
                    >
                      {{ row.name }}
                    </button>
                  </div>
                </div>
              </div>
              <!-- 与桌面表格同一套 out-in 过渡：轮询把状态换掉时先淡出旧值再淡入新值。 -->
              <Transition name="dd-status-switch" mode="out-in">
                <el-tag :key="row.status" :type="getStatusType(row.status)" size="small" :class="row.status === 2 ? 'tag-with-dot' : ''">
                  <span v-if="row.status === 2" class="pulse-dot"></span>
                  {{ getStatusText(row.status) }}
                </el-tag>
              </Transition>
            </div>

            <div class="dd-mobile-card__badges task-name-inline">
              <el-tag size="small" effect="plain" class="task-label task-label--type">
                {{ getTaskTypeLabel(row.task_type) }}
              </el-tag>
              <!-- 订阅锁：手改过名称/定时的任务不再被订阅拉取覆盖，也不会被自动删除 -->
              <el-tag
                v-if="row.subscription_locked"
                size="small"
                effect="plain"
                type="warning"
                class="task-label"
                title="已手动调整过名称/定时，订阅拉取不会覆盖，也不会自动删除"
              >
                <el-icon><Lock /></el-icon>
                已锁定
              </el-tag>
              <el-tag
                v-for="label in displayTaskLabels(row)"
                :key="label"
                size="small"
                effect="plain"
                class="task-label"
              >
                {{ label }}
              </el-tag>
            </div>

            <div class="dd-mobile-card__subtitle task-card__command">
              <code class="command-text">
                <template v-if="splitTaskCommandDisplay(row.command).script">
                  <span>{{ splitTaskCommandDisplay(row.command).before }}</span>
                  <span class="script-link" @click.stop="navigateToScript(splitTaskCommandDisplay(row.command).script!)">{{ splitTaskCommandDisplay(row.command).script }}</span>
                  <span>{{ splitTaskCommandDisplay(row.command).after }}</span>
                </template>
                <template v-else>{{ row.command }}</template>
              </code>
            </div>
          </div>
        </div>

        <div class="dd-mobile-card__body">
          <div class="dd-mobile-card__grid">
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">定时规则</span>
              <div class="dd-mobile-card__value">
                <template v-if="row.task_type === 'cron'">
                  <TaskCronList
                    :expressions="getCronExpressions(row)"
                    compact
                  />
                </template>
                <span v-else class="text-muted">{{ getTaskTypeLabel(row.task_type) }}</span>
              </div>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">上次结果</span>
              <div class="dd-mobile-card__value">
                <div class="last-run-result">
                  <Transition name="dd-status-switch" mode="out-in">
                    <el-tag :key="String(row.last_run_status)" :type="getRunStatusType(row.last_run_status)" size="small">
                      {{ getRunStatusText(row.last_run_status) }}
                    </el-tag>
                  </Transition>
                </div>
              </div>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">最后运行</span>
              <span class="dd-mobile-card__value time-text">{{ row.last_run_at ? formatTime(row.last_run_at) : '-' }}</span>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">下次运行</span>
              <span class="dd-mobile-card__value time-text">{{ row.next_run_at ? formatTime(row.next_run_at) : '-' }}</span>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">耗时</span>
              <span class="dd-mobile-card__value">{{ formatDuration(row.last_running_time) }}</span>
            </div>
          </div>

          <div class="dd-mobile-card__actions task-card__actions">
            <el-button v-if="canOperateTasks && row.status !== 2" type="primary" size="small" @click="handleRun(row)">运行</el-button>
            <el-button v-else-if="canOperateTasks" type="warning" size="small" @click="handleStop(row)">停止</el-button>
            <el-button v-if="canOperateTasks" :type="row.status === 0 ? 'success' : 'danger'" size="small" plain @click="handleToggle(row)">
              {{ row.status === 0 ? '启用' : '禁用' }}
            </el-button>
            <el-button size="small" @click="openLogViewer(row)">实时日志</el-button>
            <el-button v-if="canOperateTasks" size="small" @click="openEdit(row)">编辑</el-button>
            <el-dropdown trigger="click" placement="bottom-end">
              <el-button size="small">
                更多
                <el-icon><More /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="openDetail(row)">详情</el-dropdown-item>
                  <el-dropdown-item @click="openLogFiles(row)">日志文件</el-dropdown-item>
                  <el-dropdown-item v-if="canOperateTasks" @click="handleCopy(row)">复制</el-dropdown-item>
                  <el-dropdown-item v-if="canOperateTasks" @click="handlePin(row)">{{ row.is_pinned ? '取消置顶' : '置顶' }}</el-dropdown-item>
                  <el-dropdown-item v-if="canOperateTasks" divided @click="handleDelete(row)">
                    <span style="color: var(--el-color-danger)">删除</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>

      <el-empty v-if="!loading && tasks.length === 0" description="暂无任务" />
    </div>

    <div v-else class="table-card" :class="{ 'is-compact': isNarrowDesktop }">
      <el-table
        v-loading="loading"
        :data="tasks"
        :height="desktopTableHeight"
        @selection-change="handleSelectionChange"
        style="width: 100%"
        :header-cell-style="{ background: '#f8fafc', color: '#64748b', fontWeight: 600, fontSize: '13px' }"
        :row-style="{ cursor: 'pointer' }"
      >
        <el-table-column v-if="canOperateTasks" type="selection" width="40" />
        <!-- 三个弹性列按 min-width 的比例瓜分剩余宽度（EP 的分配规则）。
             窄桌面改成 90 : 70 : 95：cron 表达式长度固定且短，全显出来价值最高；
             命令是长路径，任何窄宽度下都得省略，让它少分一点最划算。 -->
        <el-table-column label="任务名称" :min-width="isNarrowDesktop ? 90 : 80">
          <template #default="{ row }">
            <div class="task-name-cell">
              <el-icon v-if="row.is_pinned" class="pin-icon" :class="{ 'is-readonly': !canOperateTasks }" @click.stop="canOperateTasks && handlePin(row)"><Star /></el-icon>
              <div class="task-name-info">
                <div class="task-name-inline">
                  <button
                    type="button"
                    class="task-name-text task-name-link"
                    :title="`查看 ${row.name} 的日志文件`"
                    @click.stop="openLogFiles(row)"
                  >
                    {{ row.name }}
                  </button>
                  <!-- 窄桌面隐藏任务类型标签：它和右边的「定时规则」列完全冗余
                       （cron 类型显示表达式、其余类型显示的就是这个标签的文案），
                       但在被压窄的名称列里它会独占一行，是行高翻倍的直接原因 -->
                  <el-tag v-if="!isNarrowDesktop" size="small" effect="plain" class="task-label task-label--type">
                    {{ getTaskTypeLabel(row.task_type) }}
                  </el-tag>
                  <!-- 订阅锁：手改过名称/定时的任务不再被订阅拉取覆盖，也不会被自动删除 -->
                  <el-tag
                    v-if="row.subscription_locked"
                    size="small"
                    effect="plain"
                    type="warning"
                    class="task-label"
                    title="已手动调整过名称/定时，订阅拉取不会覆盖，也不会自动删除"
                  >
                    <el-icon><Lock /></el-icon>
                    已锁定
                  </el-tag>
                  <el-tag
                    v-for="label in displayTaskLabels(row)"
                    :key="label"
                    size="small"
                    effect="plain"
                    class="task-label"
                  >
                    {{ label }}
                  </el-tag>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="命令 / 脚本" :min-width="isNarrowDesktop ? 70 : 80">
          <template #default="{ row }">
            <!-- 窄桌面下这一列会被压到 100px 出头，不省略就要换 5 行；title 挂全文兜底 -->
            <code class="command-text" :title="row.command">
              <template v-if="splitTaskCommandDisplay(row.command).script">
                <span>{{ splitTaskCommandDisplay(row.command).before }}</span>
                <span class="script-link" @click.stop="navigateToScript(splitTaskCommandDisplay(row.command).script!)">{{ splitTaskCommandDisplay(row.command).script }}</span>
                <span>{{ splitTaskCommandDisplay(row.command).after }}</span>
              </template>
              <template v-else>{{ row.command }}</template>
            </code>
          </template>
        </el-table-column>
        <el-table-column label="定时规则" :min-width="isNarrowDesktop ? 95 : 70">
          <template #default="{ row }">
            <template v-if="row.task_type === 'cron'">
              <TaskCronList
                :expressions="getCronExpressions(row)"
                compact
              />
            </template>
            <span v-else class="text-muted">{{ getTaskTypeLabel(row.task_type) }}</span>
          </template>
        </el-table-column>
        <!-- 窄桌面把「状态」「上次结果」收到刚好装下标签的宽度，省出的 36px 还给
             名称/命令/定时规则三个弹性列，让 cron 表达式尽量不被省略号截断 -->
        <el-table-column label="状态" :width="isNarrowDesktop ? 90 : 110" align="center">
          <template #default="{ row }">
            <!-- 3 秒一轮的状态轮询会让这枚 tag 在 禁用中/排队中/运行中/空闲中 之间来回跳，
                 硬切时用户只看到文字忽然变了、不确定是自己看花眼还是真的变了。
                 out-in 让旧状态先淡出、新状态再淡入，变化本身有了可见的过程。
                 key 必须绑【状态值】：绑 row.id 的话同一行永远是同一个 key，节点被原地复用，
                 过渡一次都不会触发。 -->
            <Transition name="dd-status-switch" mode="out-in">
              <el-tag :key="row.status" :type="getStatusType(row.status)" size="small" :class="row.status === 2 ? 'tag-with-dot' : ''">
                <span v-if="row.status === 2" class="pulse-dot"></span>
                {{ getStatusText(row.status) }}
              </el-tag>
            </Transition>
          </template>
        </el-table-column>
        <!-- 窄桌面隐藏「最后运行」「耗时」：这两列固定占 250px，是把弹性列压到下限的主因。
             信息没丢——任务详情弹窗里都有，「下次运行」「上次结果」这两个更常看的仍然保留。 -->
        <el-table-column v-if="!isNarrowDesktop" label="最后运行" width="160" align="center">
          <template #default="{ row }">
            <span v-if="row.last_run_at" class="time-text">{{ formatTime(row.last_run_at) }}</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="下次运行" width="160" align="center">
          <template #default="{ row }">
            <span v-if="row.next_run_at" class="time-text">{{ formatTime(row.next_run_at) }}</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="上次结果" :width="isNarrowDesktop ? 84 : 100" align="center">
          <template #default="{ row }">
            <div class="last-run-result">
              <!-- 同一轮轮询里，任务跑完的那一刻这里会从「未运行」翻成「成功 / 失败 / 已终止」，
                   是全表最值得被看见的一次变化。key 走 String()：last_run_status 为 null（未运行）时
                   直接绑 null 会被 Vue 当成「没有 key」，和有 key 的节点比较时行为不稳定。 -->
              <Transition name="dd-status-switch" mode="out-in">
                <el-tag :key="String(row.last_run_status)" :type="getRunStatusType(row.last_run_status)" size="small">
                  {{ getRunStatusText(row.last_run_status) }}
                </el-tag>
              </Transition>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="!isNarrowDesktop" label="耗时" width="90" align="center">
          <template #default="{ row }">
            <span v-if="row.last_running_time != null" class="time-text">{{ formatDuration(row.last_running_time) }}</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <!--
          列宽 140：EP 的 .el-table .cell 是 padding:0 12px + overflow:hidden，可用内容宽 = 列宽 - 24。
          五个按钮 + ⋯ 收成一个 Split Button 后，最宽的形态是【观察者】那一支：
          主体「实时日志」= 4×12px 文字 + 22px 内边距 + 2px 边框 = 72px，caret 半边 32px，合计 104px；
          140 - 24 = 116，余量 12px。有操作权限那一支主体只有「运行 / 停止」两个字，合计 80px，余量 36px。
          caret 是 32px 不是 24px：EP 2.13 的 el-dropdown 根节点只挂 `el-dropdown` + `is-disabled`，
          不带 size 修饰类，所以 `.el-dropdown--small .el-dropdown__caret-button{width:24px}` 根本匹配不上，
          size="small" 的 split button 也是 32px 的 caret —— 估宽时别按 24px 算。
          按钮组一旦超出可用宽，.cell 就会变成可滚动容器，点 caret 时整行会被滚偏，详见下方 .action-btns 注释。
          窄桌面（<1600px）与常规桌面按钮形态完全一致，因此两种模式共用这一个宽度。
        -->
        <el-table-column label="操作" width="140" fixed="right" align="center">
          <template #default="{ row }">
            <div class="action-btns">
              <!-- 主体是「运行」，任务运行中（status===2）整个换成「停止」：两者互斥，谁上了主体谁就不在
                   菜单里出现，不会有「停止 ▾」点开还挂着「停止」这种事。
                   主体敢放运行/停止，是因为 handleRun / handleStop 各自都带 ElMessageBox 二次确认，
                   点错的代价是按一下 Esc；删除不可撤销，所以它只能待在菜单里（danger + divided）。

                   触发器贴在表格最右侧，DdSplitButton 默认 placement="bottom-end" 让菜单右对齐触发器。
                   EP 在 dropdown.vue 里把 fallback-placements 写死成 ['bottom','top']（2.13.5 仍是如此，
                   props 覆盖不掉），靠近视口底部放不下时仍会退回居中的 top —— 这属于 EP 限制；
                   但按钮组已从 228px 收到 80px，就算退回居中，菜单也只在表格内挪一点，不会被顶到窗口边。 -->
              <DdSplitButton
                v-if="canOperateTasks"
                :label="row.status === 2 ? '停止' : '运行'"
                :type="row.status === 2 ? 'warning' : 'primary'"
                size="small"
                :items="taskActionItems(row)"
                @click="row.status === 2 ? handleStop(row) : handleRun(row)"
                @command="(key: string) => onTaskAction(key, row)"
              />
              <!-- 观察者：运行/停止/启用/编辑/复制/置顶/删除全部无权（handler 里 ensureCanOperate 会直接拦下），
                   主体只能给只读操作。改造前这一档顶层唯一的按钮就是「实时日志」，层级原样保留；
                   菜单里剩下的也仍然只有「详情 / 日志文件」，由 taskActionItems 的 visible 联动。 -->
              <DdSplitButton
                v-else
                label="实时日志"
                type="default"
                size="small"
                :items="taskActionItems(row)"
                @click="openLogViewer(row)"
                @command="(key: string) => onTaskAction(key, row)"
              />
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="pagination-bar">
      <span class="pagination-total">共 {{ total }} 条数据</span>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="sizes, prev, pager, next"
        @current-change="loadTasks"
        @size-change="handlePageSizeChange"
      />
    </div>

    <TaskForm
      v-model:visible="formVisible"
      :task="editingTask"
      :prefill="prefillData"
      :default-python-version="defaultPythonVersion"
      :python-runtimes="pythonRuntimeOptions"
      :notification-channels="notificationChannels"
      @submit="handleFormSubmit"
    />

    <LogViewer
      v-model:visible="logViewerVisible"
      :task-id="logViewerTaskId"
      :task-name="logViewerTaskName"
      :mode="logViewerMode"
    />

    <TaskDetail
      v-model:visible="detailVisible"
      :task="detailTask"
      :can-operate="canOperateTasks"
      @restore-subscription-default="handleRestoreSubscriptionDefault"
    />

    <LogFileBrowser
      v-model:visible="logFilesVisible"
      :task-id="logFilesTaskId"
      :task-name="logFilesTaskName"
    />

    <BatchAddLabelDialog
      v-model:visible="batchLabelVisible"
      :task-ids="selectedIds"
      @success="handleBatchLabelSuccess"
    />
  </div>
</template>

<style scoped lang="scss">
.tasks-page {
  padding: 0;
  font-size: 14px;
  min-width: 0;
}

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

// 工具条：与上方 ViewManager 留出协调间距，左右两区一行排布、gap 统一
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 14px 0;
  gap: 12px;
  flex-wrap: wrap;

  &__left {
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
  }

  &__search {
    width: 260px;
  }
}

// 状态分段控件：对齐全站统一的 .dd-seg-group / .dd-seg-btn 观感（直角容器 + 选中态白底品牌色 + 1px 描边）
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
  // 透明描边占位，选中时只换 border-color，避免出现 1px 的尺寸跳动
  border: 1px solid transparent;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    color var(--dd-motion-fast) var(--dd-ease-standard),
    background-color var(--dd-motion-fast) var(--dd-ease-standard),
    border-color var(--dd-motion-fast) var(--dd-ease-standard);
  white-space: nowrap;

  &:hover {
    color: var(--el-text-color-primary);
  }

  &.active {
    background: var(--el-bg-color);
    color: var(--el-color-primary);
    border-color: var(--el-border-color-lighter);
    font-weight: 600;
  }
}

.batch-actions {
  display: flex;
  gap: 8px;
}

// 批量操作条进出场：只改 opacity。
// 不做高度/宽度过渡 —— .toolbar 是 flex-wrap 容器，尺寸每帧变一次就要重新算一遍换行，整页跟着重排。
.dd-batch-actions-enter-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-decelerate);
}

.dd-batch-actions-leave-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-standard);
}

.dd-batch-actions-enter-from,
.dd-batch-actions-leave-to {
  opacity: 0;
}

// 快捷排序触发按钮：图标与文案留出间距，文案过长时不撑破工具栏
.sort-dropdown__text {
  margin-left: 4px;
  white-space: nowrap;
}

:deep(.tag-with-dot) {
  display: inline-flex !important;
  align-items: center;
  gap: 5px;
}

// 状态 tag 的 out-in 切换：只用 opacity。
// 表格行里禁止位移——tag 一动，同一格的基线跟着抖，视觉上整行都在晃。
// 这里的选择器要落到 el-tag 的根元素上：子组件根节点会继承父作用域的 data-v，scoped 下能命中。
.dd-status-switch-enter-active,
.dd-status-switch-leave-active {
  transition: opacity var(--dd-motion-fast) var(--dd-ease-standard);
}

.dd-status-switch-enter-from,
.dd-status-switch-leave-to {
  opacity: 0;
}

// 表格卡：直角无阴影，仅靠 1px 边框与页面底色区分（dd-fixed-page 下的 flex:1 + 内部滚动由全局规则接管）
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

  .pin-icon {
    color: var(--el-color-warning);
    cursor: pointer;
    font-size: 16px;
    flex-shrink: 0;

    &.is-readonly {
      cursor: default;
    }
  }
}

.task-name-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.task-name-text {
  font-weight: 500;
  color: var(--el-text-color-primary);
  min-width: 0;
}

.task-name-link {
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--el-color-primary);
  font: inherit;
  line-height: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  // 时长/缓动只能取令牌：写死毫秒会绕过 prefers-reduced-motion 下把令牌压到 1ms 的降级
  transition:
    color var(--dd-motion-fast) var(--dd-ease-standard),
    text-decoration-color var(--dd-motion-fast) var(--dd-ease-standard);

  &:hover {
    color: var(--el-color-primary-dark-2);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--el-color-primary) 45%, transparent);
    outline-offset: 2px;
    border-radius: 0;
  }
}

.task-name-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.task-label {
  font-size: 11px !important;
  border-radius: 0;

  &--type {
    background: rgba(64, 158, 255, 0.08);
    color: var(--el-color-primary);
    border-color: transparent;
  }
}

.command-text {
  font-family: var(--dd-font-mono);
  font-size: 13px;
  color: var(--el-text-color-secondary);
  word-break: break-all;

  .script-link {
    color: var(--el-color-primary);
    cursor: pointer;
    &:hover { text-decoration: underline; }
  }
}

.time-text {
  font-family: var(--dd-font-mono);
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.text-muted {
  color: var(--el-text-color-placeholder);
}

.last-run-result {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  // out-in 有一段「旧的已走、新的未来」的空档，这一格会瞬间没有内容。
  // 撑住 el-tag small 的高度，免得移动端网格里这一格塌成 0、把同行其它字段拽着抖一下。
  // 桌面表格的行高由定时规则/操作列撑着，这里只是顺带保险。
  min-height: 20px;
}

.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;

  // EP 自带 `.el-button + .el-button { margin-left: 12px }`，它会叠加在上面的 flex gap 上：
  // 连续四个按钮凭空多吃 36px，按钮组总宽超过「操作」列的可用内容宽（列宽 - .cell 的 24px 内边距），
  // 于是 .cell（EP 给的 overflow:hidden）变成可滚动容器 —— 点最右边的 ⋯ 时浏览器会把获得焦点的
  // 按钮滚进可视区，整行按钮左移、最左边的「运行」被裁掉且不会自动复位。
  // 间距统一交给 gap，这里把这份外边距清零；顺带修掉「前四个按钮间距 16px、编辑与 ⋯ 之间只有 4px」的不一致。
  //
  // 这五个按钮 + ⋯ 现在收成了一个 DdSplitButton，这条规则对它是空转（EP 的 el-button-group
  // 本来就把组内相邻按钮的 margin-left 归零）。保留的理由有两条：上面这段是「操作列为什么会自己
  // 横向滚起来」的唯一记录；以及哪天又往这一格里塞第二个按钮时，这个坑不用重新踩一遍。
  //
  // 原来这里还有一条 `:deep(.el-button) { padding: 4px 8px }`，是当年硬挤五个文字按钮才加的。
  // 现在只剩一个实心 Split Button，压内边距只会让它显得局促，已经去掉，改回 EP small 档默认的
  // 5px 11px —— 与 Open API 页的同款按钮保持一致，列宽估算也按这个默认值算。
  :deep(.el-button + .el-button) {
    margin-left: 0;
  }
}

// 分页条：与表格卡视觉衔接，间距/字号收敛
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

@media screen and (min-width: 769px) {
  .tasks-page {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tasks-page > * {
    flex-shrink: 0;
    min-width: 0;
  }

  .table-card {
    flex: 1 1 0;
    height: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  :deep(.table-card .el-table) {
    flex: 1 1 auto;
    min-height: 0;
  }

  .pagination-bar {
    flex-shrink: 0;
  }
}

:deep(.el-table) {
  // 边框统一走令牌，明暗自动适配（原写死浅灰会在暗色串色）
  --el-table-border-color: var(--el-border-color-lighter);

  .el-table__header-wrapper th {
    border-bottom: 1px solid var(--el-border-color-light);
  }

  .el-table__row td {
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .el-table__cell {
    padding: 12px 0;
  }

  .el-table-column--selection .cell {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

// ===== 窄桌面紧凑模式（视口 <1600px，由 isNarrowDesktop 挂 .is-compact）=====
// 目标是把行高从 94~186px 压回 40px 上下。三件事一起做才有效，缺一件都会被最高的那格顶回去：
//   1) 命令 / 定时规则单行省略（不省略就是 5 行和 3 行）；
//   2) 名称行不再换行（配合模板里隐藏任务类型标签，多数行只剩一行文字）；
//   3) 收紧单元格上下内边距。
// 列的隐藏在模板里做（v-if="!isNarrowDesktop"），不在这里用 display:none —— el-table 的
// 列宽是 JS 算出来写进 <colgroup> 的，CSS 藏列只会留下一段空白，宽度并不会还给其它列。
.table-card.is-compact {
  :deep(.el-table__cell) {
    padding: 6px 0;
  }

  .command-text {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    // 单行省略要求不能按字符断行，否则 text-overflow 不生效
    word-break: normal;
  }

  // 名称行保持 wrap：一旦改成 nowrap，标签（flex-shrink:0）会把任务名挤成 0 宽，
  // 出现「只剩两个标签、名字整个不见了」。让标签换到第二行，名字始终独占第一行。
  .task-name-link {
    flex: 1 1 100%;
  }

  .task-label {
    flex-shrink: 0;
  }

  :deep(.task-cron-list__code) {
    // 内边距从 4px 8px 收到 3px 6px：正好让 `0 8,15,21 * * *` 这类 15 字符的表达式
    // 在窄桌面的列宽里完整显示，而不是差几个像素被省略号截掉
    padding: 3px 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: normal;
  }
}

.task-card {
  .command-text {
    display: block;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.task-card__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.task-card__name-block {
  min-width: 0;
}

.task-card__name-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.task-card__actions {
  > * {
    flex: 1 1 calc(50% - 4px);
  }
}

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
    align-items: stretch;
    gap: 10px;

    &__left {
      flex-direction: column;
      gap: 10px;
    }

    &__search {
      width: 100% !important;
    }

    &__right {
      justify-content: flex-end;
    }
  }

  .status-tabs {
    width: 100%;
    overflow-x: auto;
  }

  .batch-actions {
    flex-wrap: wrap;
  }
}

// ===== 入场动画 =====
// 只对卡片级容器（工具条 / 表格卡 / 移动列表）做克制的淡入上移 + 轻微错落；
// 不给表格每一行做 stagger（行数多会卡）。时长走令牌，prefers-reduced-motion 时令牌自动降为 1ms 即等效关闭。
@keyframes dd-tasks-rise-in {
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
  animation: dd-tasks-rise-in var(--dd-motion-page) var(--dd-ease-decelerate) both;
}

// 轻微错落：工具条先入，表格卡/移动列表略晚
.table-card,
.dd-mobile-list {
  animation-delay: 60ms;
}
</style>
