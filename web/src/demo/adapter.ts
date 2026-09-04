import axios, { AxiosError } from 'axios'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import request from '@/api/request'
import notificationTypesFixture from './fixtures/notification-types.json'
import {
  appendTaskRunLog,
  buildDashboard,
  buildLogContent,
  buildScriptList,
  buildScriptTree,
  buildSystemBadges,
  buildSystemStats,
  db,
  filterEnvs,
  filterLogs,
  filterTasks,
  findScriptFile,
  findTask,
  isValidEnvName,
  joinEnvGroups,
  nextEnvPosition,
  nextId,
  nextRunTimes,
  nowIso,
  paginate,
  reorderEnv,
  reorderTask,
  saveScriptContent,
  sortEnvs,
  splitEnvGroups,
  toEnvDict,
  toLogDict,
  toTaskDict,
} from './db'
import { DEMO_PANEL_VERSION, demoPanelSettings } from './shortcuts'
import { cancelDemoTaskRun, startDemoTaskRun } from './taskRuns'
import type { DemoOpenApp, DemoTask, DemoTaskLog, DemoUser } from './types'
import { TASK_STATUS_DISABLED, TASK_STATUS_ENABLED, TASK_STATUS_RUNNING } from './types'

/**
 * ⚠️ fixtures/notification-types.json 与 fixtures/configs.json 是【生成产物，不要手改】。
 *
 * 重新生成：
 *   cd server
 *   go run ./cmd/gen-demo-fixtures
 *
 * 它们的真源在服务端，不在这里：
 *   notification-types.json <- server/model/notify_channel_registry.go
 *   configs.json            <- server/model/system_config_registry.go
 *
 * .trellis/spec/frontend/index.md 有专门一节讲这件事：这两类知识只允许有一份声明。
 * 通知渠道字段历史上在仓库里存在过四份副本并且已经漂移过（apiData.ts 的 wecom_app 漏了
 * mpnews），手写这两个文件就是制造第五份副本。后端加渠道 / 加配置项时，
 * 只要重跑一次生成器，演示站就自动跟上，不需要在这里改任何代码。
 *
 * 业务数据（任务、日志、脚本、环境变量……）是另一回事：服务端没有对应的注册表，
 * 它们是手写剧本，放在 fixtures/business.ts 与 fixtures/scripts.ts。
 */

/**
 * 在线演示 Demo 的浏览器内 mock 传输层。
 *
 * 整个面板的网络调用收敛度很高：约 175 个端点全部走 web/src/api/request.ts 里那一个
 * axios 实例，所以不需要 Service Worker / MSW，换掉 axios 的 adapter 就能全量接管。
 *
 * ⚠️ 本目录下的所有代码只会进入 `npm run build:demo` 的产物。
 *    发布版构建里 import.meta.env.VITE_DEMO 是编译期常量 ''，
 *    main.ts 的挂载分支连同这个 chunk 会被 rollup 整段剔除。
 *    不要在 demo 目录之外静态 import 这里的任何东西，那会直接打破这条约束。
 */

/** 统一的假延迟。0 延迟会让所有 loading 态一闪而过，反而不像真实网络。 */
const DEMO_LATENCY_MS = 80

const DEMO_ACCESS_TOKEN = 'demo-access-token'
const DEMO_REFRESH_TOKEN = 'demo-refresh-token'

const BLOCKED_MESSAGE = '演示环境不可用'

/**
 * 「这个动作在演示环境里做不了」。
 *
 * 抛它的端点会被 adapter 转成一次带 403 的拒绝 + 一条 warning toast。
 * 为什么不是返回 200 + 一句提示：像「重启面板」「系统更新」这类按钮，
 * 拿到 200 之后页面会进入等待重启的轮询（fetch('/', HEAD) → 静态站恒 200 → 自动刷新），
 * 演示数据当场全丢。拒绝掉才能让那条路径根本走不进去。
 *
 * ⚠️ 状态码必须是 403，不能是 401 —— request.ts:54 遇到 401 会尝试刷新 token，
 *    失败就 clearAuth() 并跳登录页。
 */
class DemoBlockedError extends Error {
  constructor(message: string = BLOCKED_MESSAGE) {
    super(message)
    this.name = 'DemoBlockedError'
  }
}

function blocked(message?: string): never {
  throw new DemoBlockedError(message)
}

let lastBlockedNoticeAt = 0

/**
 * 弹「演示环境不可用」。
 *
 * 必须由 adapter 自己弹，不能指望调用方：
 *   - useSettingsOverview 的 handleRestartPanel 整个 catch 是空的，什么都不提示；
 *   - deps 页的 handleCreate catch 里写死的是「提交安装失败」。
 * 两处都不会把服务端给的 error 文案透出来，访客只会觉得「点了没反应」。
 *
 * 1.2 秒内的重复提示直接丢弃：批量操作会连着打好几发请求。
 */
function notifyBlocked(message: string) {
  const now = Date.now()
  if (now - lastBlockedNoticeAt < 1200) return
  lastBlockedNoticeAt = now
  ElMessage({ type: 'warning', message, grouping: true })
}

/** 请求经过归一化之后交给各端点处理函数的上下文 */
interface DemoRequestContext {
  /** 已转大写，如 GET / POST */
  method: string
  /** 已剥掉 /api 或 /api/v1 前缀的路径，如 /auth/user */
  path: string
  /** URL 查询串与 axios config.params 合并后的结果 */
  params: Record<string, string>
  /** 路径变量，如 /tasks/:id 里的 id */
  vars: Record<string, string>
  /** 请求体（能解析成 JSON 时是对象，否则原样） */
  body: any
}

type DemoHandler = (ctx: DemoRequestContext) => unknown

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

const exactRoutes = new Map<string, DemoHandler>()
const patternRoutes: Array<{ method: string; regex: RegExp; keys: string[]; handler: DemoHandler }> = []

/**
 * 注册一个端点。
 *
 * 静态路径进 Map（O(1) 命中），带 `:var` 的进有序数组（按注册顺序匹配）。
 * ⚠️ 静态路径永远优先于模式路径，所以 `/envs/by-name` 不会被 `/envs/:id` 抢走；
 *    模式之间则按注册顺序，注册 `/tasks/views/:id` 必须早于 `/tasks/:id`。
 */
function route(method: string, template: string, handler: DemoHandler) {
  if (!template.includes(':')) {
    exactRoutes.set(`${method} ${template}`, handler)
    return
  }

  const keys: string[] = []
  const source = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
    keys.push(key)
    return '([^/]+)'
  })
  patternRoutes.push({ method, regex: new RegExp(`^${source}$`), keys, handler })
}

function resolveHandler(method: string, path: string): { handler: DemoHandler; vars: Record<string, string> } | null {
  const exact = exactRoutes.get(`${method} ${path}`)
  if (exact) return { handler: exact, vars: {} }

  for (const item of patternRoutes) {
    if (item.method !== method) continue
    const matched = item.regex.exec(path)
    if (!matched) continue

    const vars: Record<string, string> = {}
    item.keys.forEach((key, index) => {
      vars[key] = decodeURIComponent(matched[index + 1] ?? '')
    })
    return { handler: item.handler, vars }
  }

  return null
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function intVar(ctx: DemoRequestContext, key = 'id'): number {
  return Number.parseInt(ctx.vars[key] ?? '', 10)
}

function bodyObject(ctx: DemoRequestContext): Record<string, any> {
  return ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {}
}

function idList(ctx: DemoRequestContext, ...keys: string[]): number[] {
  const body = bodyObject(ctx)
  for (const key of keys) {
    const raw = body[key]
    if (Array.isArray(raw)) {
      return raw.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    }
  }
  return []
}

/** 需要 404 语义时用它：页面普遍读 err.response.data.error 展示 */
function notFound(message: string): never {
  throw new AxiosError(message, 'ERR_BAD_REQUEST', undefined, null, {
    status: 404,
    statusText: 'Not Found',
    data: { error: message },
    headers: {},
    config: { headers: {} },
  } as unknown as AxiosResponse)
}

/**
 * 兜底响应体。
 *
 * ⚠️ 这是整套 mock 里最重要的一条规则：**任何未命中的请求都必须返回 200 + 空数据，
 *    绝不能返回 401 / 4xx / 5xx**。
 *    web/src/api/request.ts 的响应拦截器遇到 401 会尝试刷新 token，失败就 clearAuth()
 *    并跳转登录页——只要有任意一个次要端点回 401，访客就会被踢出面板。
 *
 * 形状同时照顾两类调用方：
 *   - 列表页普遍是 `list.value = res.data`（如 tasks/index.vue，没有 || [] 兜底），
 *     所以 data 必须至少是数组；
 *   - 分页组件读 total / page / page_size。
 *
 * 每次都返回新对象：页面可能就地 push / splice，共享同一个引用会互相污染。
 */
function createFallbackBody() {
  return { data: [], total: 0, page: 1, page_size: 20 }
}

// ===========================================================================
// 登录与会话
// ===========================================================================

/**
 * 演示访客本人。avatar_url 恒为空串，见 fixtures/business.ts 里的说明。
 *
 * 兜底到一个常量对象而不是允许返回 undefined：访客可以在用户管理页把账号删光，
 * 而 GET /auth/user 一旦返回空对象，router.beforeEach 会 clearAuth() 把人踢回登录页。
 */
const FALLBACK_DEMO_USER: DemoUser = {
  id: 1,
  username: 'demo',
  role: 'admin',
  enabled: true,
  avatar_url: '',
  last_login_at: null,
  created_at: '2026-01-05T09:12:00.000Z',
  updated_at: '2026-01-05T09:12:00.000Z',
}

function demoUser(): DemoUser {
  const current = db()
  return current.users.find((user) => user.username === 'demo')
    ?? current.users[0]
    ?? FALLBACK_DEMO_USER
}

// need_init:false 才会走「登录」而不是「初始化管理员」流程
route('GET', '/auth/check-init', () => ({ need_init: false }))

// enabled:false 会让 login/index.vue 提前 return，
// 从而【阻止极验 SDK 的 <script src="https://static.geetest.com/..."> 被注入】。
// 那是 script 标签注入，不走 fetch/XHR，任何网络层 mock 都拦不住；
// 演示站没有后端，SDK 一旦被注入就会卡在「极验 SDK 加载失败」上，登录直接走不下去。
route('GET', '/auth/captcha-config', () => ({
  enabled: false,
  captcha_id: '',
  configured: false,
  implemented: false,
  required: false,
  require_after_failures: 0,
  message: '',
}))

// 唯一的硬阻塞：router.beforeEach 在没有 user 时会 await fetchUser()，
// 这里失败会 clearAuth() 并打回登录页，15 个页面一个都进不去。
route('GET', '/auth/user', () => ({ user: demoUser() }))

route('POST', '/auth/login', () => ({
  message: '登录成功',
  access_token: DEMO_ACCESS_TOKEN,
  refresh_token: DEMO_REFRESH_TOKEN,
  user: demoUser(),
}))
route('POST', '/auth/logout', () => ({ message: '已退出登录' }))
// 走的是 api/auth.ts 里那个裸全局 axios（见文件末尾的双实例挂载说明）
route('POST', '/auth/refresh', () => ({ access_token: DEMO_ACCESS_TOKEN }))
route('POST', '/auth/init', () => ({ message: '初始化成功', user: demoUser() }))
route('PUT', '/auth/password', () => ({ message: '密码修改成功' }))

route('PUT', '/auth/username', (ctx) => {
  const user = demoUser()
  const username = String(bodyObject(ctx)['username'] ?? '').trim()
  if (!user || !username) return notFound('用户名不能为空')
  user.username = username
  user.updated_at = nowIso()
  return { message: '用户名已更新', user }
})

// 头像上传要真生效就得把文件转成 data: URL 存起来，而 C5 明确要求 avatar_url 恒为空
//（MainLayout 那三处 <img> 没有 @error 兜底）。与其做半套，不如直接说明这里不可用。
route('POST', '/auth/avatar', () => blocked())
route('DELETE', '/auth/avatar', () => ({ message: '头像已删除' }))

// ===========================================================================
// 系统信息 / 面板设置
// ===========================================================================

// 版本号与面板设置的真值放在 demo/shortcuts.ts —— 登录页的裸 fetch 与 utils/panelSettings.ts
// 的裸 fetch 都绕过 axios，只能在各自的生产文件里短路，那两处也从同一份常量取值，
// 免得演示站上出现「侧边栏 v3.0.6、登录页却是另一个号」这种自相矛盾。
route('GET', '/system/version', () => ({ data: { version: DEMO_PANEL_VERSION } }))
route('GET', '/system/public-version', () => ({ version: DEMO_PANEL_VERSION }))
route('GET', '/system/panel-settings', () => ({ data: demoPanelSettings() }))
route('GET', '/system/machine-code', () => ({ data: { machine_code: 'DEMO-0000-0000-0000' } }))

route('GET', '/system/info', () => ({
  data: {
    os: 'linux',
    arch: 'amd64',
    deployment_type: 'docker',
    magisk_shell_version: 0,
    cpu_usage: 12.5,
    memory_usage: 45.2,
    disk_usage: 32.1,
    num_cpu: 4,
    goroutines: 28,
    uptime: '6d 4h 18m',
    memory_used: 1073741824,
    memory_total: 2147483648,
    disk_used: 10737418240,
    disk_total: 32212254720,
    go_version: 'go1.26.4',
  },
}))

// 仪表盘与「系统概况」的每一个数字都是从 db 里的 tasks / logs 现算的，
// 这里不再写死任何常量，详见 db.ts 的 buildDashboard / buildSystemStats。
route('GET', '/system/dashboard', (ctx) => ({ data: buildDashboard(ctx.params) }))
route('GET', '/system/stats', () => ({ data: buildSystemStats() }))
// 侧栏角标：同样是现算的，访客运行任务后运行中角标会真的跳动
route('GET', '/system/badges', () => ({ data: buildSystemBadges() }))

// 类型是 SystemHealthSnapshot，页面直接读 .items，走兜底体会拿到 undefined
function healthSnapshot() {
  return {
    items: [
      { name: '面板服务', status: 'ok', message: '演示环境运行中' },
      { name: '数据库', status: 'ok', message: '连接正常' },
      { name: '任务调度器', status: 'ok', message: `已加载 ${db().tasks.length} 个任务` },
      { name: '磁盘空间', status: 'ok', message: '已用 32.1%' },
      { name: '网络连通性', status: 'warn', message: '演示环境无外网出口' },
    ],
    last_checked_at: nowIso(),
  }
}
route('GET', '/system/health-check', () => healthSnapshot())
route('POST', '/system/health-check', () => healthSnapshot())

route('GET', '/system/panel-log', (ctx) => {
  const keyword = (ctx.params['keyword'] ?? '').trim()
  const level = (ctx.params['level'] ?? '').trim().toLowerCase()
  const lines = [
    '[INFO] 面板启动完成，监听 0.0.0.0:8080',
    `[INFO] 已加载 ${db().tasks.length} 个定时任务`,
    '[INFO] 订阅调度器已启动，3 个订阅',
    '[INFO] 任务 系统健康检查 开始执行',
    '[WARN] 任务 证书到期巡检 退出码 1，已触发通知',
    '[INFO] 任务 同步配置文件 执行完成，耗时 4.2s',
    '[INFO] 备份计划任务已跳过：本日已存在自动备份',
    '[ERROR] 通知渠道 （停用）旧告警群 已禁用，跳过推送',
    '[INFO] 这里是演示环境，日志内容为静态样例',
  ]
  const filtered = lines.filter((line) => {
    if (level && !line.toLowerCase().includes(`[${level}]`)) return false
    return !keyword || line.includes(keyword)
  })
  return { data: { logs: filtered } }
})

// 「配置文件」页：真可写，保存后重新打开内容保持
route('GET', '/system/config-script', () => ({
  content: db().configScript,
  path: 'config/extra.sh',
}))
route('PUT', '/system/config-script', (ctx) => {
  db().configScript = String(bodyObject(ctx)['content'] ?? '')
  return { message: '配置文件已保存' }
})

route('GET', '/system/backups', () => ({ data: db().backups }))
route('DELETE', '/system/backup', (ctx) => {
  const current = db()
  const filename = ctx.params['filename'] ?? ''
  current.backups = current.backups.filter((item) => item.name !== filename)
  return { message: '删除成功' }
})

route('GET', '/system/restore/progress', () => ({
  data: { active: false, status: 'idle', percent: 0 },
}))

route('GET', '/system/update-status', () => ({ data: { status: 'idle' } }))
route('GET', '/system/check-update', () => ({
  data: {
    current: DEMO_PANEL_VERSION || '0.0.0',
    latest: DEMO_PANEL_VERSION || '0.0.0',
    has_update: false,
    auto_update_supported: false,
    update_disabled_reason: '演示环境不支持面板内更新',
    release_notes: '',
    update_target: { deployment_type: 'docker' },
  },
}))

// ---- 危险操作：一律拒绝 + toast ------------------------------------------
// 这些按钮在真实面板上会动到进程或数据；在演示站上更要命的是「重启 / 更新 / 恢复」
// 拿到 200 之后页面会开始轮询 fetch('/', {method:'HEAD'})，
// 静态站的 / 一旦返 200 就会被判定为「服务已回来」⇒ window.location.reload()，
// 访客的全部演示数据当场清零。
//
// 这条防线是两层的，两层都要在：
//   1. 这里拒绝，让那些轮询路径根本走不进去；
//   2. useSettingsOverview / useSettingsSecurity 的 waitForRestart / waitForAvailability
//      入口处还各有一道 VITE_DEMO 守卫兜底（design C4）——
//      因为 useSettingsSecurity 的 doRestart() 把 restart 的异常 try/catch 吞掉了，
//      光靠这里的 403【拦不住它】，它照样会往下调到轮询。
route('POST', '/system/update', () => blocked())
route('POST', '/system/restart', () => blocked())
route('POST', '/system/stop', () => blocked())
route('POST', '/system/restore', () => blocked())
route('POST', '/system/backup', () => blocked())
route('POST', '/system/backup/upload', () => blocked())
// 备份文件是编出来的剧本，没有真实内容可下；给个空文件比给个 200 更诚实
route('GET', '/system/backup/download', () => blocked())

// ===========================================================================
// 系统配置（/configs）
// ===========================================================================

// configApi.list 的类型是 { data: SystemConfigMap }，是「键 -> 配置项」的对象而不是数组。
// fixture 是「全新安装、system_configs 表一行都没有」时的响应：每项的 value 等于
// 注册表里的 default_value（依据 server/handler/config.go:87-89）。
// 设置页 6 个 tab 的表单、以及按 schema 兜底渲染的 ExtraConfigCard 都读它。
route('GET', '/configs', () => ({ data: db().configs }))

route('GET', '/configs/:key', (ctx) => {
  const key = ctx.vars['key'] ?? ''
  const item = db().configs[key]
  if (!item) return notFound('配置不存在')
  return { data: { key, value: item.value ?? '', config: item } }
})

function setConfigValue(key: string, value: string) {
  const current = db()
  const existing = current.configs[key]
  if (existing) {
    existing.value = value
    existing.updated_at = nowIso()
    return
  }
  // 注册表里没有的键：与服务端一致，仍然存下来，只是 registered=false（不参与 schema 渲染）
  current.configs[key] = { value, registered: false, updated_at: nowIso() }
}

route('POST', '/configs', (ctx) => {
  const body = bodyObject(ctx)
  const key = String(body['key'] ?? '').trim()
  if (!key) return notFound('配置项不存在')
  setConfigValue(key, String(body['value'] ?? ''))
  return { message: '配置已更新' }
})

route('PUT', '/configs/batch', (ctx) => {
  const configs = bodyObject(ctx)['configs']
  if (configs && typeof configs === 'object') {
    for (const [key, value] of Object.entries(configs as Record<string, unknown>)) {
      setConfigValue(key, String(value ?? ''))
    }
  }
  return { message: '配置已更新' }
})

route('DELETE', '/configs/:key', (ctx) => {
  const key = ctx.vars['key'] ?? ''
  delete db().configs[key]
  return { message: '配置已删除' }
})

// ===========================================================================
// 定时任务
// ===========================================================================

/** 任务表单可以写的字段。没列进来的（id / created_at / 运行态）一律不允许被请求体覆盖。 */
const TASK_WRITABLE_KEYS = [
  'name', 'command', 'python_version', 'cron_expression', 'task_type', 'timeout',
  'success_exit_codes', 'random_delay_seconds', 'max_retries', 'retry_interval',
  'notify_on_failure', 'notify_on_success', 'notify_on_abort', 'notification_channel_id',
  'depends_on', 'task_before', 'task_after', 'allow_multiple_instances', 'stop_schedule',
] as const

function applyTaskPayload(task: DemoTask, body: Record<string, any>) {
  for (const key of TASK_WRITABLE_KEYS) {
    if (body[key] === undefined) continue
    // 逐字段赋值而不是 Object.assign(task, body)：后者会让请求体里夹带的
    // id / status / created_at 直接覆盖掉运行态，属于「客户端说什么就是什么」
    ;(task as unknown as Record<string, unknown>)[key] = body[key]
  }
  if (Array.isArray(body['labels'])) {
    task.labels = body['labels'].map((label: unknown) => String(label))
  }
  if (typeof body['status'] === 'number') {
    task.status = body['status']
  }
  task.updated_at = nowIso()
}

function createTask(body: Record<string, any>): DemoTask {
  const now = nowIso()
  const task: DemoTask = {
    id: nextId('task'),
    name: String(body['name'] ?? '未命名任务'),
    command: String(body['command'] ?? ''),
    python_version: String(body['python_version'] ?? ''),
    cron_expression: String(body['cron_expression'] ?? ''),
    task_type: String(body['task_type'] ?? 'cron'),
    status: TASK_STATUS_ENABLED,
    labels: Array.isArray(body['labels']) ? body['labels'].map((label: unknown) => String(label)) : [],
    last_run_at: null,
    last_run_status: null,
    timeout: Number(body['timeout'] ?? 0),
    success_exit_codes: String(body['success_exit_codes'] ?? '0'),
    random_delay_seconds: body['random_delay_seconds'] ?? null,
    max_retries: Number(body['max_retries'] ?? 0),
    retry_interval: Number(body['retry_interval'] ?? 0),
    notify_on_failure: Boolean(body['notify_on_failure']),
    notify_on_success: Boolean(body['notify_on_success']),
    notify_on_abort: Boolean(body['notify_on_abort']),
    notification_channel_id: body['notification_channel_id'] ?? null,
    depends_on: body['depends_on'] ?? null,
    // 与服务端 model 的 `default:0` 一致：新任务不参与已有的拖拽编号（那一桶被拖过的话是 10/20/30…），
    // 0 比它们都小 ⇒ 新任务照旧排在最前面
    list_order: 0,
    // 新建的任务排在最前面：服务端默认排序里 sort_order 越小越靠前
    sort_order: -1,
    is_pinned: false,
    subscription_locked: false,
    pid: null,
    log_path: null,
    last_running_time: null,
    task_before: body['task_before'] ?? null,
    task_after: body['task_after'] ?? null,
    allow_multiple_instances: Boolean(body['allow_multiple_instances']),
    stop_schedule: String(body['stop_schedule'] ?? ''),
    created_at: now,
    updated_at: now,
  }
  db().tasks.push(task)
  return task
}

function requireTask(ctx: DemoRequestContext): DemoTask {
  const task = findTask(intVar(ctx))
  if (!task) return notFound('任务不存在')
  return task
}

route('GET', '/tasks', (ctx) => {
  const page = paginate(filterTasks(ctx.params), ctx.params)
  return { ...page, data: page.data.map(toTaskDict) }
})

route('GET', '/tasks/notification-channels', () => ({
  data: db().channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    push_scope: channel.push_scope,
    enabled: channel.enabled,
  })),
}))

// 这两个端点返回的是【裸数组】，不是 { data: [...] } 信封
//（api/taskView.ts:38 与 api/task.ts:130 的返回类型可以佐证）。
// 兜底体是对象，页面上的 .map / .filter 会直接抛错，必须单独列出来。
// 同类的还有 GET /tasks/{id}/log-files。
route('GET', '/tasks/views', () => [...db().taskViews].sort((left, right) => left.sort_order - right.sort_order))

route('POST', '/tasks/views', (ctx) => {
  const body = bodyObject(ctx)
  const current = db()
  const view = {
    id: nextId('taskView'),
    name: String(body['name'] ?? '新视图'),
    filters: String(body['filters'] ?? '[]'),
    sort_rules: String(body['sort_rules'] ?? '[]'),
    hidden: false,
    sort_order: current.taskViews.length,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  current.taskViews.push(view)
  return view
})

// reorder 是静态路径，会被 exactRoutes 先命中，不会被下面的 /tasks/views/:id 抢走。
// 但 /tasks/views/:id 与 /tasks/:id 都是模式路由，两者【按注册顺序匹配】，
// 所以 /tasks/views/:id 必须写在 /tasks/:id 前面（本文件里确实如此，别调换）。
route('PUT', '/tasks/views/reorder', (ctx) => {
  const current = db()
  const items = bodyObject(ctx)['views']
  if (Array.isArray(items)) {
    for (const item of items as Array<Record<string, unknown>>) {
      const view = current.taskViews.find((row) => row.id === Number(item['id']))
      if (!view) continue
      view.sort_order = Number(item['sort_order'] ?? view.sort_order)
      if (typeof item['hidden'] === 'boolean') view.hidden = item['hidden']
      view.updated_at = nowIso()
    }
  }
  const views = [...current.taskViews].sort((left, right) => left.sort_order - right.sort_order)
  return { updated: views.length, views }
})

route('PUT', '/tasks/views/:id', (ctx) => {
  const view = db().taskViews.find((row) => row.id === intVar(ctx))
  if (!view) return notFound('视图不存在')
  const body = bodyObject(ctx)
  if (body['name'] !== undefined) view.name = String(body['name'])
  if (body['filters'] !== undefined) view.filters = String(body['filters'])
  if (body['sort_rules'] !== undefined) view.sort_rules = String(body['sort_rules'])
  if (typeof body['hidden'] === 'boolean') view.hidden = body['hidden']
  if (body['sort_order'] !== undefined) view.sort_order = Number(body['sort_order'])
  view.updated_at = nowIso()
  return view
})

route('DELETE', '/tasks/views/:id', (ctx) => {
  const current = db()
  current.taskViews = current.taskViews.filter((row) => row.id !== intVar(ctx))
  return { message: '视图已删除' }
})

// cron 模板与解析：模板照抄 server/pkg/cron/cron.go 的 GetTemplates()（六段含秒），
// 解析结果的字段名照抄 handler/task_cron.go 的 CronParse。
const CRON_TEMPLATES = [
  { name: '每分钟', expression: '0 * * * * *', description: '每分钟执行一次', category: '高频' },
  { name: '每5分钟', expression: '0 */5 * * * *', description: '每5分钟执行一次', category: '高频' },
  { name: '每10分钟', expression: '0 */10 * * * *', description: '每10分钟执行一次', category: '高频' },
  { name: '每15分钟', expression: '0 */15 * * * *', description: '每15分钟执行一次', category: '高频' },
  { name: '每30分钟', expression: '0 */30 * * * *', description: '每30分钟执行一次', category: '常用' },
  { name: '每小时', expression: '0 0 * * * *', description: '每小时整点执行', category: '常用' },
  { name: '每2小时', expression: '0 0 */2 * * *', description: '每2小时执行一次', category: '常用' },
  { name: '每6小时', expression: '0 0 */6 * * *', description: '每6小时执行一次', category: '常用' },
  { name: '每天0点', expression: '0 0 0 * * *', description: '每天凌晨0点执行', category: '每天' },
  { name: '每天6点', expression: '0 0 6 * * *', description: '每天早上6点执行', category: '每天' },
  { name: '每天9点', expression: '0 0 9 * * *', description: '每天上午9点执行', category: '每天' },
  { name: '每天12点', expression: '0 0 12 * * *', description: '每天中午12点执行', category: '每天' },
  { name: '每天18点', expression: '0 0 18 * * *', description: '每天下午6点执行', category: '每天' },
  { name: '工作日9点', expression: '0 0 9 * * 1-5', description: '工作日上午9点执行', category: '工作日' },
  { name: '工作日18点', expression: '0 0 18 * * 1-5', description: '工作日下午6点执行', category: '工作日' },
  { name: '周末10点', expression: '0 0 10 * * 0,6', description: '周末上午10点执行', category: '周末' },
  { name: '每周一0点', expression: '0 0 0 * * 1', description: '每周一凌晨0点执行', category: '每周' },
  { name: '每月1日0点', expression: '0 0 0 1 * *', description: '每月1日凌晨0点执行', category: '每月' },
  { name: '每月15日0点', expression: '0 0 0 15 * *', description: '每月15日凌晨0点执行', category: '每月' },
]

route('GET', '/tasks/cron/templates', () => CRON_TEMPLATES)

route('POST', '/tasks/cron/parse', (ctx) => {
  const expression = String(bodyObject(ctx)['expression'] ?? '').trim()
  const times = nextRunTimes(expression, Date.now(), 5)
  if (times.length === 0) {
    return { is_valid: false, error: '无法解析该 cron 表达式' }
  }
  const fieldCount = expression.split(/\s+/).length
  return {
    is_valid: true,
    description: '演示环境按标准 cron 语义解析',
    next_run_times: times,
    format: fieldCount === 6 ? '扩展格式 (6位含秒)' : '标准格式 (5位)',
  }
})

route('DELETE', '/tasks/clean-logs', (ctx) => {
  const days = Number.parseInt(ctx.params['days'] ?? '', 10)
  const current = db()
  const cutoff = Date.now() - (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000
  const before = current.logs.length
  current.logs = current.logs.filter((log) => new Date(log.started_at).getTime() >= cutoff)
  return { message: `已清理 ${before - current.logs.length} 条日志` }
})

route('GET', '/tasks/export', () => ({ data: db().tasks.map(toTaskDict) }))

route('POST', '/tasks/import', (ctx) => {
  const rows = bodyObject(ctx)['tasks']
  if (!Array.isArray(rows)) return { message: '未导入任何任务', errors: ['请求内容为空'] }
  for (const row of rows as Array<Record<string, any>>) createTask(row)
  return { message: `成功导入 ${rows.length} 个任务`, errors: [] }
})

// ---- 批量操作（静态路径必须先于 /tasks/:id 系列声明才不会被抢） ------------
route('PUT', '/tasks/batch/enable', (ctx) => {
  const ids = idList(ctx, 'task_ids', 'ids')
  for (const task of db().tasks) {
    if (ids.includes(task.id)) task.status = TASK_STATUS_ENABLED
  }
  return { message: `已启用 ${ids.length} 个任务`, success_count: ids.length }
})

route('PUT', '/tasks/batch/disable', (ctx) => {
  const ids = idList(ctx, 'task_ids', 'ids')
  for (const task of db().tasks) {
    if (ids.includes(task.id)) task.status = TASK_STATUS_DISABLED
  }
  return { message: `已禁用 ${ids.length} 个任务`, success_count: ids.length }
})

route('DELETE', '/tasks/batch/delete', (ctx) => {
  const ids = idList(ctx, 'task_ids', 'ids')
  const current = db()
  current.tasks = current.tasks.filter((task) => !ids.includes(task.id))
  return { message: `已删除 ${ids.length} 个任务`, count: ids.length }
})

// 批量运行【刻意】和单个运行不一样：这里直接记一次已完成的执行，不走 startDemoTaskRun。
// 批量入口不会打开任何实时日志弹窗，没人会去看那几条流；置成运行中只会让仪表盘的
// 「运行中的任务」瞬间涨一大截，还得靠兜底定时器一条条收回来。
route('POST', '/tasks/batch/run', (ctx) => {
  const ids = idList(ctx, 'task_ids', 'ids')
  for (const id of ids) {
    const task = findTask(id)
    if (task) appendTaskRunLog(task, 'ok', 2 + Math.random() * 6)
  }
  return { message: `已提交 ${ids.length} 个任务`, count: ids.length }
})

route('PUT', '/tasks/batch/add-labels', (ctx) => {
  const ids = idList(ctx, 'task_ids', 'ids')
  const labels = bodyObject(ctx)['labels']
  if (Array.isArray(labels)) {
    for (const task of db().tasks) {
      if (!ids.includes(task.id)) continue
      for (const label of labels as unknown[]) {
        const value = String(label).trim()
        if (value && !task.labels.includes(value)) task.labels.push(value)
      }
      task.updated_at = nowIso()
    }
  }
  return { message: `已为 ${ids.length} 个任务添加标签`, success_count: ids.length }
})

route('PUT', '/tasks/batch', (ctx) => {
  const body = bodyObject(ctx)
  const ids = idList(ctx, 'ids', 'task_ids')
  const action = String(body['action'] ?? '')
  const current = db()

  switch (action) {
    case 'enable':
      current.tasks.forEach((task) => { if (ids.includes(task.id)) task.status = TASK_STATUS_ENABLED })
      break
    case 'disable':
      current.tasks.forEach((task) => { if (ids.includes(task.id)) task.status = TASK_STATUS_DISABLED })
      break
    case 'delete':
      current.tasks = current.tasks.filter((task) => !ids.includes(task.id))
      break
    case 'run':
      ids.forEach((id) => {
        const task = findTask(id)
        if (task) appendTaskRunLog(task, 'ok', 2 + Math.random() * 6)
      })
      break
    default:
      break
  }
  return { message: `已处理 ${ids.length} 个任务`, count: ids.length }
})

/**
 * 列表拖拽排序。
 *
 * ⚠️ 必须注册在 /tasks/:id 之前：/tasks/sort 是静态路径、会先进 exactRoutes 被 O(1) 命中，
 *    但本文件的既有约定就是「静态段路由写在 /:id 前面」（见 /tasks/views/reorder 那段注释），
 *    以后有人把它改成带变量的形状时才不会被 /tasks/:id 抢走。
 * ⚠️ 这里必须真的改数据顺序（db.reorderTask 会重排整桶的 list_order）。
 *    只回一句成功而不动数据的话，页面下一次 loadTasks 会把行弹回原位，就是「拖了个寂寞」。
 */
route('PUT', '/tasks/sort', (ctx) => {
  const body = bodyObject(ctx)
  const targetRaw = body['target_id']
  const result = reorderTask(
    Number(body['source_id']),
    targetRaw === undefined || targetRaw === null ? undefined : Number(targetRaw),
    body['position'] === undefined || body['position'] === null ? undefined : String(body['position']),
  )
  if (!result.ok) return notFound(result.error)
  return { message: '排序更新成功' }
})

route('POST', '/tasks', (ctx) => {
  const task = createTask(bodyObject(ctx))
  return { message: '创建成功', data: toTaskDict(task) }
})

// ---- 单个任务 --------------------------------------------------------------
route('GET', '/tasks/:id/log-files', () => [])

route('GET', '/tasks/:id/latest-log', (ctx) => {
  const task = requireTask(ctx)
  const log = db().logs.find((row) => row.task_id === task.id)
  if (!log) return null
  return toLogDict(log, true)
})

route('GET', '/tasks/:id/live-logs', (ctx) => {
  const task = requireTask(ctx)
  const log = db().logs.find((row) => row.task_id === task.id)
  return {
    logs: log ? buildLogContent(log).split('\n') : [],
    done: task.status !== TASK_STATUS_RUNNING,
    status: task.status,
  }
})

route('GET', '/tasks/:id/stats', (ctx) => {
  const task = requireTask(ctx)
  const logs = db().logs.filter((row) => row.task_id === task.id)
  const success = logs.filter((row) => row.status === 0).length
  const failed = logs.filter((row) => row.status === 1).length
  const durations = logs.map((row) => row.duration).filter((value): value is number => value != null)
  const avg = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0
  return {
    data: {
      task_id: task.id,
      total: logs.length,
      success,
      failed,
      success_rate: success + failed > 0 ? (success / (success + failed)) * 100 : 0,
      avg_duration: Math.round(avg * 10) / 10,
    },
  }
})

route('PUT', '/tasks/:id/run', (ctx) => {
  const task = requireTask(ctx)
  // 落一条【运行中】的日志并把任务置为运行中，而不是直接记一次已完成的执行。
  //
  // 理由：views/tasks/index.vue:429-433 拿到 200 之后会立刻打开实时日志弹窗。
  // 如果这里直接给一条已完成的日志，那个弹窗就没有任何东西可滚，
  // 演示里最有观赏性的一幕（进度条在原地跳动）直接消失。
  //
  // 收尾交给 demo/taskRuns.ts：假日志流吐完最后一行会主动收尾，
  // 访客没打开弹窗时也有兜底定时器兜住，不会留下永远「运行中」的记录。
  startDemoTaskRun(task)
  return { message: '任务已开始执行' }
})

route('PUT', '/tasks/:id/stop', (ctx) => {
  const task = requireTask(ctx)
  // 先撤掉兜底定时器，否则 9 秒后它会把这条刚被终止的记录又翻成成功
  cancelDemoTaskRun(task.id)
  const running = db().logs.find((row) => row.task_id === task.id && row.status === 2)
  if (running) {
    running.status = 3
    running.kind = 'abort'
    running.duration = Math.round(((Date.now() - new Date(running.started_at).getTime()) / 1000) * 10) / 10
    running.ended_at = nowIso()
  }
  task.status = TASK_STATUS_ENABLED
  task.pid = null
  task.updated_at = nowIso()
  return { message: '任务已停止' }
})

route('PUT', '/tasks/:id/enable', (ctx) => {
  const task = requireTask(ctx)
  task.status = TASK_STATUS_ENABLED
  task.updated_at = nowIso()
  return { message: '已启用', data: toTaskDict(task) }
})

route('PUT', '/tasks/:id/disable', (ctx) => {
  const task = requireTask(ctx)
  task.status = TASK_STATUS_DISABLED
  task.updated_at = nowIso()
  return { message: '已禁用', data: toTaskDict(task) }
})

route('PUT', '/tasks/:id/pin', (ctx) => {
  const task = requireTask(ctx)
  task.is_pinned = true
  return { message: '已置顶' }
})

route('PUT', '/tasks/:id/unpin', (ctx) => {
  const task = requireTask(ctx)
  task.is_pinned = false
  return { message: '已取消置顶' }
})

route('PUT', '/tasks/:id/restore-subscription-default', (ctx) => {
  const task = requireTask(ctx)
  task.subscription_locked = false
  task.updated_at = nowIso()
  return { message: '已恢复为订阅默认', data: toTaskDict(task) }
})

route('POST', '/tasks/:id/copy', (ctx) => {
  const task = requireTask(ctx)
  const copied = createTask({
    ...task,
    name: `${task.name} - 副本`,
    labels: [...task.labels],
  } as Record<string, any>)
  copied.subscription_locked = false
  return { message: '复制成功', data: toTaskDict(copied) }
})

route('PUT', '/tasks/:id', (ctx) => {
  const task = requireTask(ctx)
  applyTaskPayload(task, bodyObject(ctx))
  return { message: '更新成功', data: toTaskDict(task) }
})

route('DELETE', '/tasks/:id', (ctx) => {
  const task = requireTask(ctx)
  const current = db()
  current.tasks = current.tasks.filter((row) => row.id !== task.id)
  return { message: '任务已删除' }
})

// ===========================================================================
// 执行日志
// ===========================================================================

route('GET', '/logs', (ctx) => {
  const page = paginate(filterLogs(ctx.params), ctx.params)
  return { ...page, data: page.data.map((log) => toLogDict(log)) }
})

route('DELETE', '/logs/clean', (ctx) => {
  const days = Number.parseInt(ctx.params['days'] ?? '', 10)
  const current = db()
  const cutoff = Date.now() - (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000
  const before = current.logs.length
  current.logs = current.logs.filter((log) => new Date(log.started_at).getTime() >= cutoff)
  return { message: `已清理 ${before - current.logs.length} 条日志（保留最近 ${Number.isFinite(days) ? days : 7} 天）` }
})

function deleteLogsByIds(ids: number[]) {
  const current = db()
  const before = current.logs.length
  current.logs = current.logs.filter((log) => !ids.includes(log.id))
  return before - current.logs.length
}

route('DELETE', '/logs/batch', (ctx) => ({ message: `已删除 ${deleteLogsByIds(idList(ctx, 'ids'))} 条日志` }))
route('POST', '/logs/batch-delete', (ctx) => ({ message: `已删除 ${deleteLogsByIds(idList(ctx, 'ids'))} 条日志` }))

/**
 * 「下载原始日志」的换票端点。
 *
 * utils/rawLogDownload.ts 拿到票据之后是用【原生 `<a download>`】去拉的，
 * 不经过 axios / fetch —— 真实面板靠这条路避免把 10MB 日志读进 JS 堆内存。
 * 演示环境没有服务端可以签票，但只要把 url 换成一个 `data:` URL，
 * 那句 `anchor.href = ticket.url; anchor.click()` 就能真的把文件下下来，
 * 前端一行都不用改（这也是 design C5 说的「靠数据消除，不改代码」）。
 */
function rawLogTicket(filename: string, content: string) {
  const safeName = (filename || 'log').replace(/[\\/:*?"<>|]/g, '_')
  const now = Date.now()
  return {
    // 正文里有裸 \r（进度条）和中文，必须整体 encodeURIComponent，
    // 否则 data: URL 会在第一个特殊字符处被截断。
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
    filename: safeName,
    size: new Blob([content]).size,
    // 真实票据 120 秒过期（handler/log_raw_download.go 的 rawLogTicketTTL），照抄口径
    expires_at: new Date(now + 120 * 1000).toISOString(),
    expires_in: 120,
  }
}

function logFileName(log: DemoTaskLog) {
  const day = log.started_at.slice(0, 10)
  return `${log.task_name || `task-${log.task_id}`}-${day}-${log.id}.log`
}

// 注册顺序在这里不重要：模式正则两端都锚定，`^/logs/([^/]+)$` 匹配不到
// `/logs/12/raw-ticket`，不会被下面的 `/logs/:id` 抢走。
route('GET', '/logs/:id/raw-ticket', (ctx) => {
  const log = db().logs.find((row) => row.id === intVar(ctx))
  if (!log) return notFound('日志不存在')
  return rawLogTicket(logFileName(log), buildLogContent(log))
})

// 演示环境的 `GET /tasks/:id/log-files` 返回空数组，所以这条实际走不到；
// 铺上是为了「以后 fixture 补了历史日志文件」时不至于掉进空数据兜底
// —— 那会让 ticket.url 变成 undefined，`<a href="undefined">` 静默失败，
// 表现是「点了下载没反应」，比报错更难查。
route('GET', '/tasks/:id/log-files/:filename/raw-ticket', (ctx) => {
  const task = requireTask(ctx)
  const filename = ctx.vars['filename'] || `${task.name}.log`
  const log = db().logs.find((row) => row.task_id === task.id)
  return rawLogTicket(filename, log ? buildLogContent(log) : '(演示环境没有这个日志文件)')
})

// 「日志文件夹打包下载」的换票端点。走不到的理由与上面那条一样（log-files 返回空数组），
// 铺上的理由也一样：不铺就会掉进空数据兜底，ticket.url 变 undefined、
// `<a href="undefined">` 静默失败，表现是「点了打包下载没反应」。
// 真实接口返回的是 zip，这里给一个 22 字节的空 zip（PK\x05\x06 + 18 个 0）——
// 下下来能被解压工具正常打开，只是里面没有条目，不会被当成损坏文件。
route('GET', '/tasks/:id/log-files/archive-ticket', (ctx) => {
  const task = requireTask(ctx)
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  return {
    url: 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
    filename: `${task.name}-logs-${day}.zip`.replace(/[\\/:*?"<>|]/g, '_'),
    // size 是未压缩总字节，演示环境没有历史日志文件，所以是 0
    size: 0,
    file_count: 0,
    // 真实票据 120 秒过期（handler/log_raw_download.go 的 rawLogTicketTTL），照抄口径
    expires_at: new Date(now + 120 * 1000).toISOString(),
    expires_in: 120,
  }
})

// 日志详情返回的是【裸的 log 字典】，不是 { data: ... }（handler/log.go:214 直接 Success(result)）
route('GET', '/logs/:id', (ctx) => {
  const log = db().logs.find((row) => row.id === intVar(ctx))
  if (!log) return notFound('日志不存在')
  return toLogDict(log, true)
})

route('DELETE', '/logs/:id', (ctx) => {
  deleteLogsByIds([intVar(ctx)])
  return { message: '日志已删除' }
})

// ===========================================================================
// 环境变量
// ===========================================================================

route('GET', '/envs', (ctx) => {
  const page = paginate(filterEnvs(ctx.params), ctx.params)
  return { ...page, data: page.data.map(toEnvDict) }
})

route('GET', '/envs/groups', () => {
  const groups = new Set<string>()
  for (const env of db().envs) {
    for (const group of splitEnvGroups(env.group)) groups.add(group)
  }
  return { data: [...groups].sort() }
})

route('GET', '/envs/export', () => {
  const data: Record<string, string> = {}
  for (const env of sortEnvs(db().envs)) {
    if (env.enabled) data[env.name] = env.value
  }
  return { data }
})

route('GET', '/envs/export-all', () => ({
  data: sortEnvs(db().envs).map((env) => ({
    name: env.name,
    value: env.value,
    remarks: env.remarks,
    group: env.group,
    groups: splitEnvGroups(env.group),
    enabled: env.enabled,
  })),
}))

route('POST', '/envs/export-files', (ctx) => {
  const format = String(bodyObject(ctx)['format'] ?? 'all')
  const rows = sortEnvs(db().envs).filter((env) => env.enabled)
  const result: Record<string, string> = {}

  if (format === 'shell' || format === 'all') {
    result['shell'] = ['#!/bin/bash', '# 呆呆面板 - 环境变量', '']
      .concat(rows.map((env) => `export ${env.name}='${env.value.replace(/'/g, "'\\''")}'`))
      .join('\n')
  }
  if (format === 'js' || format === 'all') {
    result['js'] = ['// 呆呆面板 - 环境变量', '']
      .concat(rows.map((env) => `process.env.${env.name} = ${JSON.stringify(env.value)};`))
      .join('\n')
  }
  if (format === 'python' || format === 'all') {
    result['python'] = ['# -*- coding: utf-8 -*-', '# 呆呆面板 - 环境变量', 'import os', '']
      .concat(rows.map((env) => `os.environ['${env.name}'] = ${JSON.stringify(env.value)}`))
      .join('\n')
  }
  return { data: result }
})

/**
 * 拖拽排序。
 *
 * ⚠️ 这里必须真的改数据顺序（db.reorderEnv 会重排整桶的 position）。
 *    只回一句成功而不动数据的话，页面下一次 loadData 会把行弹回原位，
 *    看起来就是「拖了个寂寞」。
 */
route('PUT', '/envs/sort', (ctx) => {
  const body = bodyObject(ctx)
  const targetRaw = body['target_id']
  const result = reorderEnv(
    Number(body['source_id']),
    targetRaw === undefined || targetRaw === null ? undefined : Number(targetRaw),
  )
  if (!result.ok) return notFound(result.error)
  return { message: '排序更新成功' }
})

route('PUT', '/envs/by-name', (ctx) => {
  const body = bodyObject(ctx)
  const name = String(body['name'] ?? '').trim()
  if (!isValidEnvName(name)) return notFound('变量名格式无效')

  const current = db()
  const existing = current.envs.find((env) => env.name === name)
  if (existing) {
    if (body['value'] !== undefined) existing.value = String(body['value'])
    if (body['remarks'] !== undefined) existing.remarks = String(body['remarks'])
    existing.updated_at = nowIso()
    return { message: '更新成功', data: toEnvDict(existing), created: false }
  }

  const created = createEnv(body)
  return { message: '创建成功', data: toEnvDict(created), created: true }
})

function createEnv(item: Record<string, any>) {
  const now = nowIso()
  const env = {
    id: nextId('env'),
    name: String(item['name'] ?? ''),
    value: String(item['value'] ?? ''),
    remarks: String(item['remarks'] ?? ''),
    enabled: item['enabled'] === undefined ? true : Boolean(item['enabled']),
    position: nextEnvPosition(0),
    sort_order: 0,
    group: Array.isArray(item['groups'])
      ? joinEnvGroups(item['groups'].map((group: unknown) => String(group)))
      : joinEnvGroups([String(item['group'] ?? '')]),
    created_at: now,
    updated_at: now,
  }
  db().envs.push(env)
  return env
}

route('POST', '/envs', (ctx) => {
  // 青龙兼容：请求体既可能是单个对象，也可能是数组
  const raw = ctx.body
  const items: Array<Record<string, any>> = Array.isArray(raw) ? raw : [bodyObject(ctx)]
  const created: Array<Record<string, unknown>> = []
  const errors: string[] = []

  items.forEach((item, index) => {
    const name = String(item['name'] ?? '').trim()
    if (!name) {
      errors.push(`第 ${index + 1} 项: 缺少名称`)
      return
    }
    if (!isValidEnvName(name)) {
      errors.push(`第 ${index + 1} 项: 变量名 '${name}' 格式无效`)
      return
    }
    created.push(toEnvDict(createEnv({ ...item, name })))
  })

  if (created.length === 1 && errors.length === 0) {
    return { message: '创建成功', data: created[0] }
  }
  return { message: `新增 ${created.length} 条`, data: created, errors, created: created.length }
})

route('DELETE', '/envs/batch', (ctx) => {
  const ids = idList(ctx, 'ids')
  const current = db()
  current.envs = current.envs.filter((env) => !ids.includes(env.id))
  return { message: `已删除 ${ids.length} 个环境变量` }
})

route('PUT', '/envs/batch/rename', (ctx) => {
  const body = bodyObject(ctx)
  const ids = idList(ctx, 'ids')
  const name = String(body['name'] ?? '').trim()
  const search = String(body['search'] ?? '')
  const replace = String(body['replace'] ?? '')

  let changed = 0
  for (const env of db().envs) {
    if (!ids.includes(env.id)) continue
    const next = name || (search ? env.name.split(search).join(replace) : env.name)
    if (next === env.name || !isValidEnvName(next)) continue
    env.name = next
    env.updated_at = nowIso()
    changed += 1
  }
  return { message: `已批量改名 ${changed} 个环境变量` }
})

route('PUT', '/envs/batch/enable', (ctx) => {
  const ids = idList(ctx, 'ids')
  db().envs.forEach((env) => { if (ids.includes(env.id)) env.enabled = true })
  return { message: `已启用 ${ids.length} 个环境变量` }
})

route('PUT', '/envs/batch/disable', (ctx) => {
  const ids = idList(ctx, 'ids')
  db().envs.forEach((env) => { if (ids.includes(env.id)) env.enabled = false })
  return { message: `已禁用 ${ids.length} 个环境变量` }
})

route('PUT', '/envs/batch/group', (ctx) => {
  const body = bodyObject(ctx)
  const ids = idList(ctx, 'ids')
  const group = Array.isArray(body['groups'])
    ? joinEnvGroups(body['groups'].map((item: unknown) => String(item)))
    : joinEnvGroups([String(body['group'] ?? '')])
  db().envs.forEach((env) => { if (ids.includes(env.id)) env.group = group })
  return { message: `已更新 ${ids.length} 个变量的分组` }
})

route('POST', '/envs/import', (ctx) => {
  const body = bodyObject(ctx)
  const rows = body['envs']
  if (!Array.isArray(rows)) return { message: '成功导入 0 个环境变量', errors: ['请求内容为空'] }
  if (String(body['mode'] ?? 'merge') === 'replace') db().envs = []

  let imported = 0
  for (const item of rows as Array<Record<string, any>>) {
    const name = String(item['name'] ?? '').trim()
    if (!isValidEnvName(name)) continue
    createEnv({ ...item, name })
    imported += 1
  }
  return { message: `成功导入 ${imported} 个环境变量`, errors: [] }
})

function requireEnv(ctx: DemoRequestContext) {
  const env = db().envs.find((row) => row.id === intVar(ctx))
  if (!env) return notFound('环境变量不存在')
  return env
}

route('GET', '/envs/:id', (ctx) => ({ data: toEnvDict(requireEnv(ctx)) }))

route('PUT', '/envs/:id/enable', (ctx) => {
  const env = requireEnv(ctx)
  env.enabled = true
  return { message: '已启用', data: toEnvDict(env) }
})

route('PUT', '/envs/:id/disable', (ctx) => {
  const env = requireEnv(ctx)
  env.enabled = false
  return { message: '已禁用', data: toEnvDict(env) }
})

route('PUT', '/envs/:id/move-top', (ctx) => {
  const env = requireEnv(ctx)
  const pinned = db().envs.filter((row) => row.sort_order === 1)
  const min = pinned.reduce((acc, row) => Math.min(acc, row.position), Number.POSITIVE_INFINITY)
  env.sort_order = 1
  env.position = Number.isFinite(min) ? min - 1000 : 1000
  return { message: '已置顶' }
})

route('PUT', '/envs/:id/cancel-top', (ctx) => {
  const env = requireEnv(ctx)
  env.sort_order = 0
  env.position = nextEnvPosition(0)
  return { message: '已取消置顶' }
})

route('PUT', '/envs/:id', (ctx) => {
  const env = requireEnv(ctx)
  const body = bodyObject(ctx)
  if (body['name'] !== undefined) {
    const name = String(body['name']).trim()
    if (!isValidEnvName(name)) return notFound('变量名格式无效')
    env.name = name
  }
  if (body['value'] !== undefined) env.value = String(body['value'])
  if (body['remarks'] !== undefined) env.remarks = String(body['remarks'])
  if (Array.isArray(body['groups'])) env.group = joinEnvGroups(body['groups'].map((item: unknown) => String(item)))
  else if (body['group'] !== undefined) env.group = joinEnvGroups([String(body['group'])])
  if (typeof body['enabled'] === 'boolean') env.enabled = body['enabled']
  env.updated_at = nowIso()
  return { message: '更新成功', data: toEnvDict(env) }
})

route('DELETE', '/envs/:id', (ctx) => {
  const current = db()
  current.envs = current.envs.filter((row) => row.id !== intVar(ctx))
  return { message: '删除成功' }
})

// ===========================================================================
// 脚本管理
// ===========================================================================

route('GET', '/scripts', (ctx) => {
  const rows = buildScriptList((ctx.params['keyword'] ?? '').trim())
  return { data: rows, total: rows.length }
})

route('GET', '/scripts/tree', () => ({ data: buildScriptTree() }))

/**
 * 脚本下载。
 *
 * 这条是全站少数几个 `responseType: 'blob'` 的接口之一，调用方直接
 * `URL.createObjectURL(blob)`，返回普通对象会当场 TypeError。
 * 好在 Blob 是可结构化克隆的，adapter 末尾那层 detach() 不会把它弄坏。
 */
route('GET', '/scripts/download', (ctx) => {
  const path = ctx.params['path'] ?? ''
  const file = findScriptFile(path)
  if (!file) return notFound(`文件不存在: ${path}`)
  return new Blob([file.content], { type: 'text/plain;charset=utf-8' })
})

route('GET', '/scripts/content', (ctx) => {
  const path = ctx.params['path'] ?? ''
  const file = findScriptFile(path)
  if (!file) return notFound(`文件不存在: ${path}`)
  return { data: { path, content: file.content, binary: false, is_binary: false } }
})

route('PUT', '/scripts/content', (ctx) => {
  const body = bodyObject(ctx)
  saveScriptContent(String(body['path'] ?? ''), String(body['content'] ?? ''))
  return { message: '保存成功' }
})

route('POST', '/scripts/directory', (ctx) => {
  const path = String(bodyObject(ctx)['path'] ?? '').replace(/^\/+|\/+$/g, '')
  if (!path) return notFound('路径不能为空')
  const current = db()
  if (!current.scriptDirs.includes(path)) current.scriptDirs.push(path)
  return { message: '目录已创建' }
})

route('PUT', '/scripts/rename', (ctx) => {
  const body = bodyObject(ctx)
  const oldPath = String(body['old_path'] ?? '').replace(/^\/+/, '')
  const newName = String(body['new_name'] ?? '').trim()
  const file = findScriptFile(oldPath)
  if (!file || !newName) return notFound('文件不存在')

  const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : ''
  file.path = parent ? `${parent}/${newName}` : newName
  file.mtime = Math.floor(Date.now() / 1000)
  return { message: '重命名成功', new_path: file.path }
})

route('PUT', '/scripts/move', (ctx) => {
  const body = bodyObject(ctx)
  const sourcePath = String(body['source_path'] ?? '').replace(/^\/+/, '')
  const targetDir = String(body['target_dir'] ?? '').replace(/^\/+|\/+$/g, '')
  const file = findScriptFile(sourcePath)
  if (!file) return notFound('文件不存在')

  const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
  file.path = targetDir ? `${targetDir}/${name}` : name
  return { message: '移动成功' }
})

route('POST', '/scripts/copy', (ctx) => {
  const body = bodyObject(ctx)
  const source = findScriptFile(String(body['source_path'] ?? ''))
  if (!source) return notFound('文件不存在')
  saveScriptContent(String(body['target_path'] ?? ''), source.content)
  return { message: '复制成功' }
})

// 上传需要真的读文件内容才有意义，而请求体在这一层已经是 FormData 了；
// 与其存一个空文件让访客以为上传成功，不如明确告知不可用。
route('POST', '/scripts/upload', () => blocked())

route('DELETE', '/scripts/batch', (ctx) => {
  const paths = bodyObject(ctx)['paths']
  if (Array.isArray(paths)) {
    const set = new Set(paths.map((item: unknown) => String(item).replace(/^\/+/, '')))
    const current = db()
    current.scriptFiles = current.scriptFiles.filter((file) => !set.has(file.path))
  }
  return { message: '删除成功' }
})

// 版本历史在演示环境里不铺剧本：真正有价值的是「改了能存住」，
// 空列表也是合法状态（新装的面板就是这样），不会让页面报错。
route('GET', '/scripts/versions', () => ({ data: [] }))
route('DELETE', '/scripts/versions', () => ({ message: '版本历史已清空', cleared_count: 0 }))
route('GET', '/scripts/versions/:id', () => notFound('版本不存在'))
route('PUT', '/scripts/versions/:id/rollback', () => notFound('版本不存在'))

route('POST', '/scripts/format', (ctx) => ({
  data: { content: String(bodyObject(ctx)['content'] ?? '') },
}))

// 脚本调试是【轮询】拿日志的（useScriptExecution.ts:77 的 debugLogs），不是 SSE，
// 所以这一小段与 P2 的假日志流没有关系，铺了才不会让「运行」按钮一直转圈。
route('POST', '/scripts/run', (ctx) => {
  const body = bodyObject(ctx)
  return { message: '已开始运行', run_id: `demo-${String(body['path'] ?? 'inline')}-${Date.now()}` }
})
route('POST', '/scripts/run-code', () => ({ message: '已开始运行', run_id: `demo-inline-${Date.now()}` }))
route('GET', '/scripts/run/:runId/logs', () => ({
  data: {
    logs: [
      '演示环境不会真的执行脚本。',
      '这里展示的是一段静态输出，用来说明调试面板长什么样。',
      '',
      '> exit code 0',
    ],
    done: true,
    exit_code: 0,
    status: 'success',
  },
}))
route('PUT', '/scripts/run/:runId/stop', () => ({ message: '已停止' }))
route('DELETE', '/scripts/run/:runId', () => ({ message: '已清理' }))

route('DELETE', '/scripts', (ctx) => {
  const path = (ctx.params['path'] ?? '').replace(/^\/+/, '')
  const current = db()
  const type = ctx.params['type'] ?? 'file'
  if (type === 'directory') {
    current.scriptDirs = current.scriptDirs.filter((dir) => dir !== path && !dir.startsWith(`${path}/`))
    current.scriptFiles = current.scriptFiles.filter((file) => !file.path.startsWith(`${path}/`))
  } else {
    current.scriptFiles = current.scriptFiles.filter((file) => file.path !== path)
  }
  return { message: '删除成功' }
})

// ===========================================================================
// 订阅管理 / SSH 密钥
// ===========================================================================

route('GET', '/subscriptions', (ctx) => {
  let rows = db().subscriptions
  const keyword = (ctx.params['keyword'] ?? '').trim()
  if (keyword) {
    rows = rows.filter((sub) => sub.name.includes(keyword) || sub.url.includes(keyword))
  }
  const type = (ctx.params['type'] ?? '').trim()
  if (type) rows = rows.filter((sub) => sub.type === type)
  const enabledRaw = (ctx.params['enabled'] ?? '').trim()
  if (enabledRaw !== '') {
    const enabled = enabledRaw.toLowerCase() === 'true' || enabledRaw === '1'
    rows = rows.filter((sub) => sub.enabled === enabled)
  }
  return paginate([...rows].sort((left, right) => right.created_at.localeCompare(left.created_at)), ctx.params)
})

route('POST', '/subscriptions', (ctx) => {
  const body = bodyObject(ctx)
  const now = nowIso()
  const sub = {
    id: nextId('subscription'),
    name: String(body['name'] ?? '新订阅'),
    type: String(body['type'] ?? 'git-repo'),
    url: String(body['url'] ?? ''),
    branch: String(body['branch'] ?? ''),
    schedule: String(body['schedule'] ?? ''),
    whitelist: String(body['whitelist'] ?? ''),
    blacklist: String(body['blacklist'] ?? ''),
    depend_on: String(body['depend_on'] ?? ''),
    pre_script: String(body['pre_script'] ?? ''),
    hook_script: String(body['hook_script'] ?? ''),
    auto_add_task: Boolean(body['auto_add_task']),
    auto_del_task: Boolean(body['auto_del_task']),
    enabled: body['enabled'] === undefined ? true : Boolean(body['enabled']),
    status: 0,
    last_pull_at: null,
    sub_path: String(body['sub_path'] ?? ''),
    save_dir: String(body['save_dir'] ?? ''),
    ssh_key_id: body['ssh_key_id'] ?? null,
    auth_type: String(body['auth_type'] ?? ''),
    auth_username: String(body['auth_username'] ?? ''),
    has_auth_token: Boolean(body['auth_token']),
    alias: String(body['alias'] ?? ''),
    force_overwrite: body['force_overwrite'] === undefined ? true : Boolean(body['force_overwrite']),
    // 与后端 NormalizeSubscriptionOverwriteMode 同口径：只认 force / preserve，其余一律 inherit（跟随全局）
    overwrite_mode: ['force', 'preserve'].includes(String(body['overwrite_mode'] ?? ''))
      ? String(body['overwrite_mode'])
      : 'inherit',
    // 完整检出：缺省即 false（稀疏检出），与后端布尔列的默认值一致。
    // 演示站不真的 clone 仓库，这里只做「存得住、编辑弹窗能回填」的透传。
    full_checkout: Boolean(body['full_checkout']),
    created_at: now,
    updated_at: now,
  }
  db().subscriptions.push(sub)
  return { message: '创建成功', data: sub }
})

route('DELETE', '/subscriptions/batch', (ctx) => {
  const ids = idList(ctx, 'ids')
  const current = db()
  current.subscriptions = current.subscriptions.filter((sub) => !ids.includes(sub.id))
  current.subLogs = current.subLogs.filter((log) => !ids.includes(log.subscription_id))
  return { message: `已删除 ${ids.length} 个订阅` }
})

function requireSubscription(ctx: DemoRequestContext) {
  const sub = db().subscriptions.find((row) => row.id === intVar(ctx))
  if (!sub) return notFound('订阅不存在')
  return sub
}

route('GET', '/subscriptions/:id/logs', (ctx) => {
  const id = intVar(ctx)
  const rows = db().subLogs.filter((log) => log.subscription_id === id)
  return paginate(rows, ctx.params)
})

route('PUT', '/subscriptions/:id/enable', (ctx) => {
  const sub = requireSubscription(ctx)
  sub.enabled = true
  return { message: '已启用', data: sub }
})

route('PUT', '/subscriptions/:id/disable', (ctx) => {
  const sub = requireSubscription(ctx)
  sub.enabled = false
  return { message: '已禁用', data: sub }
})

// 弹窗里滚动的实时日志由 demo/sse.ts 的假流负责；这里只负责落一条拉取记录。
//
// ⚠️ 记录必须在【本次请求里立刻】落库，不能等假流跑完再补：
//    subscriptions/index.vue:710 会在 pull 之前先读一次基线 id，
//    done 之后再查最新一条比对 —— 没有比基线更大的新记录就判 unknown，
//    弹窗上那个「成功/失败」的结论就出不来了。
// 正文与假流最后一行保持同一套说法，免得弹窗里滚的是一句、历史列表里写的是另一句。
route('PUT', '/subscriptions/:id/pull', (ctx) => {
  const sub = requireSubscription(ctx)
  const current = db()
  const pulledAt = nowIso()
  sub.last_pull_at = pulledAt
  sub.updated_at = pulledAt
  current.subLogs.unshift({
    id: nextId('subLog'),
    subscription_id: sub.id,
    subscription_name: sub.name,
    status: 0,
    content: sub.type === 'single-file'
      ? '拉取完成，更新 1 个文件'
      : '拉取完成，更新 3 个文件，新增任务 0 个',
    duration: sub.type === 'single-file' ? 3.1 : 3.5,
    created_at: pulledAt,
  })
  return { message: '已开始拉取' }
})

route('PUT', '/subscriptions/:id/pull/stop', () => ({ message: '已停止拉取' }))

route('PUT', '/subscriptions/:id', (ctx) => {
  const sub = requireSubscription(ctx)
  const body = bodyObject(ctx)
  const writable = [
    'name', 'type', 'url', 'branch', 'schedule', 'whitelist', 'blacklist', 'depend_on',
    'pre_script', 'hook_script', 'auto_add_task', 'auto_del_task', 'enabled', 'sub_path',
    'save_dir', 'ssh_key_id', 'auth_type', 'auth_username', 'alias', 'force_overwrite',
    'overwrite_mode', 'full_checkout',
  ]
  for (const key of writable) {
    if (body[key] === undefined) continue
    ;(sub as unknown as Record<string, unknown>)[key] = body[key]
  }
  // 与后端一致：脏值 / 非字符串一律归到 inherit，别让演示站存下真站不可能出现的取值
  if (!['force', 'preserve'].includes(String(sub.overwrite_mode ?? ''))) {
    sub.overwrite_mode = 'inherit'
  }
  sub.updated_at = nowIso()
  return { message: '更新成功', data: sub }
})

route('DELETE', '/subscriptions/:id', (ctx) => {
  const id = intVar(ctx)
  const current = db()
  current.subscriptions = current.subscriptions.filter((sub) => sub.id !== id)
  current.subLogs = current.subLogs.filter((log) => log.subscription_id !== id)
  return { message: '删除成功' }
})

route('GET', '/ssh-keys', () => ({ data: db().sshKeys }))

route('POST', '/ssh-keys', (ctx) => {
  const now = nowIso()
  const key = {
    id: nextId('sshKey'),
    name: String(bodyObject(ctx)['name'] ?? '新密钥'),
    created_at: now,
    updated_at: now,
  }
  db().sshKeys.push(key)
  return { message: '创建成功', data: key }
})

route('GET', '/ssh-keys/:id', (ctx) => {
  const key = db().sshKeys.find((row) => row.id === intVar(ctx))
  if (!key) return notFound('密钥不存在')
  // 私钥永远不下发明文，与服务端 ToDict()（PrivateKey 打了 json:"-"）一致
  return { data: key }
})

route('PUT', '/ssh-keys/:id', (ctx) => {
  const key = db().sshKeys.find((row) => row.id === intVar(ctx))
  if (!key) return notFound('密钥不存在')
  const name = bodyObject(ctx)['name']
  if (name !== undefined) key.name = String(name)
  key.updated_at = nowIso()
  return { message: '更新成功', data: key }
})

route('DELETE', '/ssh-keys/:id', (ctx) => {
  const current = db()
  current.sshKeys = current.sshKeys.filter((row) => row.id !== intVar(ctx))
  return { message: '删除成功' }
})

// ===========================================================================
// 通知渠道
// ===========================================================================

// 全部通知渠道及其字段定义。新建 / 编辑渠道弹窗的输入框完全靠它渲染
//（notifications/index.vue:141 拿 fields 生成表单），拿不到就是一张空表单。
route('GET', '/notifications/types', () => notificationTypesFixture)

route('GET', '/notifications', () => ({ data: db().channels }))

route('POST', '/notifications', (ctx) => {
  const body = bodyObject(ctx)
  const now = nowIso()
  const channel = {
    id: nextId('channel'),
    name: String(body['name'] ?? '新渠道'),
    type: String(body['type'] ?? 'webhook'),
    // config 服务端存的就是 JSON 字符串，页面拿到后自己 JSON.parse
    config: String(body['config'] ?? '{}'),
    push_scope: body['push_scope'] === 'bound' ? 'bound' : 'default',
    enabled: true,
    today_send_count: 0,
    last_test_at: null,
    last_test_status: '',
    created_at: now,
    updated_at: now,
  }
  db().channels.push(channel)
  return { message: '创建成功', data: channel }
})

function requireChannel(ctx: DemoRequestContext) {
  const channel = db().channels.find((row) => row.id === intVar(ctx))
  if (!channel) return notFound('通知渠道不存在')
  return channel
}

route('PUT', '/notifications/:id/enable', (ctx) => {
  const channel = requireChannel(ctx)
  channel.enabled = true
  return { message: '已启用', data: channel }
})

route('PUT', '/notifications/:id/disable', (ctx) => {
  const channel = requireChannel(ctx)
  channel.enabled = false
  return { message: '已禁用', data: channel }
})

route('POST', '/notifications/:id/test', (ctx) => {
  const channel = requireChannel(ctx)
  channel.last_test_at = nowIso()
  channel.last_test_status = 'success'
  // 说实话：演示站没有出网能力，这里不可能真发。文案直说，好过假装发成功。
  return { message: '演示环境不会真的发送通知，已记录一次测试' }
})

route('PUT', '/notifications/:id', (ctx) => {
  const channel = requireChannel(ctx)
  const body = bodyObject(ctx)
  if (body['name'] !== undefined) channel.name = String(body['name'])
  if (body['type'] !== undefined) channel.type = String(body['type'])
  if (body['config'] !== undefined) channel.config = String(body['config'])
  if (body['push_scope'] !== undefined) channel.push_scope = body['push_scope'] === 'bound' ? 'bound' : 'default'
  if (typeof body['enabled'] === 'boolean') channel.enabled = body['enabled']
  channel.updated_at = nowIso()
  return { message: '更新成功', data: channel }
})

route('DELETE', '/notifications/:id', (ctx) => {
  const id = intVar(ctx)
  const current = db()
  current.channels = current.channels.filter((row) => row.id !== id)
  // 绑了这条渠道的任务要一起解绑，否则任务详情里会挂着一个已经不存在的渠道
  current.tasks.forEach((task) => {
    if (task.notification_channel_id === id) task.notification_channel_id = null
  })
  return { message: '删除成功' }
})

// ===========================================================================
// Open API 应用
// ===========================================================================

function openAppDict(app: DemoOpenApp, withSecret = false): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: app.id,
    name: app.name,
    app_key: app.app_key,
    scopes: app.scopes,
    enabled: app.enabled,
    rate_limit: app.rate_limit,
    call_count: app.call_count,
    created_at: app.created_at,
    updated_at: app.updated_at,
  }
  if (withSecret) item['app_secret'] = app.app_secret
  return item
}

route('GET', '/open-api/apps', () => ({ data: db().openApps.map((app) => openAppDict(app)) }))

route('POST', '/open-api/apps', (ctx) => {
  const body = bodyObject(ctx)
  const now = nowIso()
  const id = nextId('openApp')
  const app: DemoOpenApp = {
    id,
    name: String(body['name'] ?? '新应用'),
    app_key: `ak_demo_${String(id).padStart(4, '0')}${Math.random().toString(36).slice(2, 10)}`,
    app_secret: `sk_demo_${Math.random().toString(36).slice(2, 18)}${Math.random().toString(36).slice(2, 18)}`,
    scopes: String(body['scopes'] ?? ''),
    enabled: true,
    rate_limit: Number(body['rate_limit'] ?? 0),
    call_count: 0,
    created_at: now,
    updated_at: now,
  }
  db().openApps.push(app)
  return { message: '创建成功', data: openAppDict(app, true) }
})

function requireOpenApp(ctx: DemoRequestContext) {
  const app = db().openApps.find((row) => row.id === intVar(ctx))
  if (!app) return notFound('应用不存在')
  return app
}

route('GET', '/open-api/apps/:id/logs', (ctx) => {
  const id = intVar(ctx)
  return paginate(db().apiCallLogs.filter((log) => log.app_id === id), ctx.params)
})

route('PUT', '/open-api/apps/:id/enable', (ctx) => {
  const app = requireOpenApp(ctx)
  app.enabled = true
  return { message: '已启用' }
})

route('PUT', '/open-api/apps/:id/disable', (ctx) => {
  const app = requireOpenApp(ctx)
  app.enabled = false
  return { message: '已禁用' }
})

route('PUT', '/open-api/apps/:id/reset-secret', (ctx) => {
  const app = requireOpenApp(ctx)
  app.app_secret = `sk_demo_${Math.random().toString(36).slice(2, 18)}${Math.random().toString(36).slice(2, 18)}`
  app.updated_at = nowIso()
  return { message: '密钥已重置', data: openAppDict(app, true) }
})

route('POST', '/open-api/apps/:id/view-secret', (ctx) => ({
  data: { app_secret: requireOpenApp(ctx).app_secret },
}))

route('PUT', '/open-api/apps/:id', (ctx) => {
  const app = requireOpenApp(ctx)
  const body = bodyObject(ctx)
  if (body['name'] !== undefined) app.name = String(body['name'])
  if (body['scopes'] !== undefined) app.scopes = String(body['scopes'])
  if (body['rate_limit'] !== undefined) app.rate_limit = Number(body['rate_limit'])
  app.updated_at = nowIso()
  return { message: '更新成功', data: openAppDict(app) }
})

route('DELETE', '/open-api/apps/:id', (ctx) => {
  const id = intVar(ctx)
  const current = db()
  current.openApps = current.openApps.filter((app) => app.id !== id)
  current.apiCallLogs = current.apiCallLogs.filter((log) => log.app_id !== id)
  return { message: '删除成功' }
})

// ===========================================================================
// 用户管理
// ===========================================================================

route('GET', '/users', () => ({ data: db().users }))

route('POST', '/users', (ctx) => {
  const body = bodyObject(ctx)
  const now = nowIso()
  const user = {
    id: nextId('user'),
    username: String(body['username'] ?? 'user'),
    role: String(body['role'] ?? 'viewer'),
    enabled: true,
    // 恒为空：MainLayout 的头像 <img> 没有 @error 兜底
    avatar_url: '',
    last_login_at: null,
    created_at: now,
    updated_at: now,
  }
  db().users.push(user)
  return { message: '创建成功', data: user }
})

route('PUT', '/users/:id/reset-password', () => ({ message: '密码已重置' }))

route('PUT', '/users/:id', (ctx) => {
  const user = db().users.find((row) => row.id === intVar(ctx))
  if (!user) return notFound('用户不存在')
  const body = bodyObject(ctx)
  if (body['role'] !== undefined) user.role = String(body['role'])
  if (typeof body['enabled'] === 'boolean') user.enabled = body['enabled']
  user.updated_at = nowIso()
  return { message: '更新成功', data: user }
})

route('DELETE', '/users/:id', (ctx) => {
  const current = db()
  current.users = current.users.filter((row) => row.id !== intVar(ctx))
  return { message: '删除成功' }
})

// ===========================================================================
// 安全（登录日志 / 会话 / IP 白名单 / 2FA）
// ===========================================================================

route('GET', '/security/login-logs', (ctx) => paginate(db().loginLogs, ctx.params))

route('DELETE', '/security/login-logs', () => {
  db().loginLogs = []
  return { message: '登录日志已清空' }
})

route('GET', '/security/sessions', () => ({ data: db().sessions }))

route('DELETE', '/security/sessions/others', () => {
  const current = db()
  current.sessions = current.sessions.slice(0, 1)
  return { message: '已注销其它会话' }
})

route('DELETE', '/security/sessions/:id', (ctx) => {
  const current = db()
  current.sessions = current.sessions.filter((row) => row.id !== intVar(ctx))
  return { message: '会话已注销' }
})

route('GET', '/security/ip-whitelist', () => ({ data: db().ipWhitelist }))

route('POST', '/security/ip-whitelist', (ctx) => {
  const body = bodyObject(ctx)
  const item = {
    id: nextId('ipWhitelist'),
    ip: String(body['ip'] ?? ''),
    remarks: String(body['remarks'] ?? ''),
    created_at: nowIso(),
  }
  db().ipWhitelist.push(item)
  return { message: '添加成功', data: item }
})

route('DELETE', '/security/ip-whitelist/:id', (ctx) => {
  const current = db()
  current.ipWhitelist = current.ipWhitelist.filter((row) => row.id !== intVar(ctx))
  return { message: '删除成功' }
})

route('GET', '/security/audit-logs', (ctx) => paginate([], ctx.params))
route('GET', '/security/login-stats', () => ({ data: { total: db().loginLogs.length, success: db().loginLogs.filter((row) => row.status === 0).length } }))

// 2FA 的完整链路（开启 → 退出 → 重新登录看到 TOTP 弹窗）属于 R2 里「不额外设计就被演示到」
// 的部分，这里只保证接口不报错；真正的密钥校验演示环境做不了。
route('GET', '/security/2fa/status', () => ({ data: { enabled: false } }))
route('POST', '/security/2fa/setup', () => ({
  data: {
    secret: 'DEMODEMODEMODEMO',
    uri: 'otpauth://totp/%E5%91%86%E5%91%86%E9%9D%A2%E6%9D%BF:demo?secret=DEMODEMODEMODEMO&issuer=DaiDaiPanel',
  },
}))
route('POST', '/security/2fa/verify', () => blocked('演示环境无法校验动态验证码'))
route('DELETE', '/security/2fa', () => ({ message: '已关闭两步验证' }))

// ===========================================================================
// 依赖管理 / Android 运行时
// ===========================================================================

route('GET', '/deps', (ctx) => {
  const type = (ctx.params['type'] ?? '').trim()
  const pythonVersion = (ctx.params['python_version'] ?? '').trim()
  const all = db().deps
  const rows = all.filter((dep) => {
    if (type && dep.type !== type) return false
    if (dep.type === 'python' && pythonVersion && dep.python_version !== pythonVersion) return false
    return true
  })
  // failed_by_type 与上面的筛选无关，永远是【全量】统计，python 一档跨所有版本：
  // 三者之和必须等于侧栏角标的 deps_failed（buildSystemBadges 同样是全量数 failed），
  // 依赖页的类型页签才能和角标对得上。同样只算不写死，跟着 Demo 数据走。
  const failedByType: Record<'nodejs' | 'python' | 'linux', number> = { nodejs: 0, python: 0, linux: 0 }
  for (const dep of all) {
    if (dep.status !== 'failed') continue
    const depType = dep.type
    if (depType === 'nodejs' || depType === 'python' || depType === 'linux') {
      failedByType[depType] += 1
    }
  }
  return { data: rows, total: rows.length, failed_by_type: failedByType }
})

route('GET', '/deps/python-runtimes', () => ({
  data: [
    { version: '3.10', label: 'Python 3.10', default: false, venv_path: '/opt/venv/py310', venv_healthy: true, python_path: '/opt/venv/py310/bin/python', pip_path: '/opt/venv/py310/bin/pip', available: true, message: '' },
    { version: '3.11', label: 'Python 3.11', default: false, venv_path: '/opt/venv/py311', venv_healthy: true, python_path: '/opt/venv/py311/bin/python', pip_path: '/opt/venv/py311/bin/pip', available: true, message: '' },
    { version: '3.12', label: 'Python 3.12', default: true, venv_path: '/opt/venv/py312', venv_healthy: true, python_path: '/opt/venv/py312/bin/python', pip_path: '/opt/venv/py312/bin/pip', available: true, message: '' },
  ],
  default_version: '3.12',
}))

route('PUT', '/deps/python-runtime-default', (ctx) => ({
  message: '默认 Python 版本已更新',
  default_version: String(bodyObject(ctx)['version'] ?? '3.12'),
}))

route('GET', '/deps/mirrors', () => ({
  pip_mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  npm_mirror: 'https://registry.npmmirror.com',
  linux_mirror: 'https://mirrors.tuna.tsinghua.edu.cn/debian',
  linux_package_manager: 'apt',
  linux_distribution: 'debian',
  linux_mirror_supported: true,
  linux_mirror_label: 'Debian',
  linux_mirror_message: '',
}))
route('PUT', '/deps/mirrors', () => ({ message: '镜像源已更新' }))

// 依赖清单导出同样是 responseType: 'blob'（见 /scripts/download 上的说明）
route('GET', '/deps/export', (ctx) => {
  const type = (ctx.params['type'] ?? 'python').trim()
  const pythonVersion = (ctx.params['python_version'] ?? '').trim()
  const names = db().deps
    .filter((dep) => dep.type === type && (!pythonVersion || dep.python_version === pythonVersion))
    .map((dep) => dep.name)
  return new Blob([`${names.join('\n')}\n`], { type: 'text/plain;charset=utf-8' })
})

route('GET', '/deps/:id/status', (ctx) => {
  const dep = db().deps.find((row) => row.id === intVar(ctx))
  if (!dep) return notFound('依赖不存在')
  return { data: { ...dep, log: '演示环境不保留安装日志' } }
})

// 依赖安装/重装会真的调 pip / npm，演示环境一律拒绝
route('POST', '/deps', () => blocked())
route('PUT', '/deps/:id/reinstall', () => blocked())
route('POST', '/deps/batch-reinstall', () => blocked())

route('POST', '/deps/batch-delete', (ctx) => {
  const ids = idList(ctx, 'ids')
  const current = db()
  current.deps = current.deps.filter((dep) => !ids.includes(dep.id))
  return { message: `已删除 ${ids.length} 个依赖` }
})

route('PUT', '/deps/:id/cancel', () => ({ message: '已取消' }))

route('DELETE', '/deps/:id', (ctx) => {
  const current = db()
  current.deps = current.deps.filter((dep) => dep.id !== intVar(ctx))
  return { message: '删除成功' }
})

route('GET', '/android-runtime/status', () => ({
  data: {
    supported: false,
    arch: 'amd64',
    bin_dir: '',
    termux_detected: false,
    runtimes: [],
    presets: [],
  },
}))
route('POST', '/android-runtime/uninstall', () => blocked())

// ===========================================================================
// 其它
// ===========================================================================

// 赞助名单要联网拉，演示环境直接给 unavailable，页面会显示「暂时无法获取」而不是空白
route('GET', '/sponsors', () => ({
  data: { sponsors: [], count: 0, total_amount: 0, updated_at: null, unavailable: true },
}))

route('GET', '/platform-tokens/platforms', () => ({ data: [] }))
route('GET', '/platform-tokens', () => ({ data: [] }))

// ---------------------------------------------------------------------------
// 请求归一化与 adapter
// ---------------------------------------------------------------------------

/**
 * 把 axios 的 config 归一化成 { method, path, params, body }。
 *
 * 注意：params 不能只从 config.url 里解析。axios 是在 adapter 内部才把 config.params
 * 拼进 URL 的，adapter 拿到的 config.url 上通常还没有查询串。
 */
function normalizeRequest(config: InternalAxiosRequestConfig): DemoRequestContext {
  const method = String(config.method || 'get').toUpperCase()
  const [pathPart = '', queryPart = ''] = resolveRawPath(config).split('?')

  const params: Record<string, string> = {}
  new URLSearchParams(queryPart).forEach((value, key) => {
    params[key] = value
  })
  if (config.params && typeof config.params === 'object') {
    for (const [key, value] of Object.entries(config.params as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      params[key] = String(value)
    }
  }

  return { method, path: stripApiPrefix(pathPart), params, vars: {}, body: parseBody(config.data) }
}

/**
 * 拼出请求的原始路径（含查询串）。
 * 等价于 axios 内部的 baseURL + url 合并规则：两侧各自去掉一个斜杠，保证中间只留一个。
 */
function resolveRawPath(config: InternalAxiosRequestConfig) {
  const url = String(config.url || '')
  // 绝对地址剥掉协议与域名（演示站不该出现跨域请求，这里只是防御，别在这里炸）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
  }

  const base = String(config.baseURL || '').replace(/\/+$/, '')
  return `${base}/${url.replace(/^\/+/, '')}`
}

/**
 * 每条路由在服务端都会在 /api 和 /api/v1 下各注册一次，
 * 这里统一收敛成不带前缀的形式，端点表只写一份。
 */
function stripApiPrefix(pathname: string) {
  let path = pathname || '/'
  if (!path.startsWith('/')) path = `/${path}`

  if (path === '/api' || path === '/api/v1') {
    path = '/'
  } else if (path.startsWith('/api/v1/')) {
    path = path.slice('/api/v1'.length)
  } else if (path.startsWith('/api/')) {
    path = path.slice('/api'.length)
  }

  // 去掉结尾斜杠（根路径除外），避免 /tasks 与 /tasks/ 被当成两个端点
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * axios 的 transformRequest 在 adapter 之前就跑完了，
 * 所以 JSON 请求体到这里已经是字符串，需要解回对象；FormData 等则原样透传。
 */
function parseBody(data: unknown) {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function buildResponse(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    config,
    request: null,
  }
}

/**
 * 把响应体深拷贝一份再交出去。
 *
 * 页面拿到列表之后普遍会就地改：open-api 页 `app.enabled = val`、任务页 `task.status = 2`、
 * 设置页把 configs 回填进表单再随手改。直接把内存里的对象引用递出去，
 * 这些改动会绕过所有 mutation 入口悄悄写进 db —— 包括「弹窗里改了一半又取消」
 * 这种根本不该落库的中间态，表现为「有时候生效有时候不生效」。
 */
function detach(body: unknown): unknown {
  try {
    return structuredClone(body)
  } catch {
    // 极端情况（body 里混进了不可结构化克隆的值）下退回原对象：
    // 宁可少一层隔离，也不能让一次响应直接抛异常
    return body
  }
}

const demoAdapter: AxiosAdapter = async (config) => {
  // 整段包 try/catch：这是「绝不逃逸出 200」这条规则的最后一道闸。
  // adapter 抛出的异常会被 axios 当成网络错误，error.response 是 undefined，
  // request.ts 的拦截器识别不出来只能原样 reject，页面弹红条——
  // 演示站里任何一个 handler 写错都不该让访客看见错误。
  let body: unknown
  try {
    const ctx = normalizeRequest(config)
    const matched = resolveHandler(ctx.method, ctx.path)

    if (!matched) {
      // 打一条 debug 方便后续补端点；这里【不能】抛错或返回非 2xx，见 createFallbackBody 的说明
      console.debug('[demo] 未铺设的端点，返回空数据兜底:', ctx.method, ctx.path)
      body = createFallbackBody()
    } else {
      ctx.vars = matched.vars
      body = matched.handler(ctx)
    }
  } catch (error) {
    await delay(DEMO_LATENCY_MS)

    if (error instanceof DemoBlockedError) {
      notifyBlocked(error.message)
      throw new AxiosError(error.message, 'ERR_BAD_REQUEST', config, null, {
        status: 403,
        statusText: 'Forbidden',
        data: { error: error.message },
        headers: {},
        config,
      } as unknown as AxiosResponse)
    }

    // notFound() 抛出来的就是这一类：状态码由 handler 决定，但【永远不会是 401】
    if (error instanceof AxiosError && error.response) {
      throw new AxiosError(
        error.message,
        error.code,
        config,
        null,
        { ...error.response, config } as unknown as AxiosResponse,
      )
    }

    console.error('[demo] mock 端点执行出错，已回落到空数据兜底:', config.url, error)
    return buildResponse(config, createFallbackBody())
  }

  await delay(DEMO_LATENCY_MS)
  return buildResponse(config, detach(body))
}

/**
 * 把 demo adapter 挂到【两个】axios 实例上。
 *
 * axios 的 adapter 是按实例生效的，而 axios.create() 在创建那一刻就把当时的
 * axios.defaults 快照进了新实例——之后再改 axios.defaults 影响不到它，反之亦然。
 * 所以这两处必须分别挂：
 *
 *   1. web/src/api/request.ts 的实例：约 175 个端点都走它；
 *   2. web/src/api/auth.ts 的 refresh()：那是 `import axios from 'axios'` 之后直接
 *      `axios.post('/api/auth/refresh')`，用的是全局默认实例。
 *      漏挂这一处 → 刷新 token 真打网络 → 演示站返回 404 → 刷新失败 →
 *      clearAuth() + 跳登录页，访客被踢出面板。
 */
export function installDemoAdapter() {
  request.defaults.adapter = demoAdapter
  axios.defaults.adapter = demoAdapter
  // 首次访问就把数据播种好：db() 是纯内存的，没有任何快照要落，
  // 后面每个 handler 直接改内存对象即可（刷新页面就回到初始 fixture）
  db()
}
