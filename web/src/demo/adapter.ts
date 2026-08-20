import axios from 'axios'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import request from '@/api/request'
import notificationTypesFixture from './fixtures/notification-types.json'
import configsFixture from './fixtures/configs.json'

/**
 * ⚠️ 上面这两个 fixture 是【生成产物，不要手改】。
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

/**
 * 演示站点展示的面板版本号。
 *
 * 由 Pages 部署流程通过 VITE_DEMO_VERSION 注入（值就是发布 tag 去掉前缀 v）。
 * 本地构建时读不到，保持空串——侧边栏是 `v-if="panelVersion"`（MainLayout.vue:189/:283），
 * 空串直接不渲染，不会出现 "vundefined" 这种脏文案。
 *
 * ⚠️ 只有侧边栏走得到这里。登录页的版本号是 login/index.vue:119 那发【裸 fetch】拿的，
 *    不经过 axios，本层拦不住，静态站上它会 404 然后被空 catch 吞掉。
 *    要让登录页也显示版本号，得按 C4 把那处裸 fetch 一起短路（属后续阶段）。
 */
const DEMO_PANEL_VERSION = String(import.meta.env.VITE_DEMO_VERSION || '')

const DEMO_ACCESS_TOKEN = 'demo-access-token'
const DEMO_REFRESH_TOKEN = 'demo-refresh-token'

/**
 * 演示访客的用户对象。
 *
 * avatar_url 必须留空：MainLayout 侧边栏与抽屉里的头像 <img> 没有 @error 兜底，
 * 一旦指向任何取不到的地址就会显示破图。留空会走「用户名首字母占位块」分支。
 */
const DEMO_USER = {
  id: 1,
  username: 'demo',
  role: 'admin',
  enabled: true,
  avatar_url: '',
  last_login_at: isoNow(),
  created_at: '2026-01-05T09:12:00Z',
  updated_at: isoNow(),
}

function isoNow() {
  return new Date().toISOString()
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 请求经过归一化之后交给各端点处理函数的上下文 */
interface DemoRequestContext {
  /** 已转大写，如 GET / POST */
  method: string
  /** 已剥掉 /api 或 /api/v1 前缀的路径，如 /auth/user */
  path: string
  /** URL 查询串与 axios config.params 合并后的结果 */
  params: Record<string, string>
  /** 请求体（能解析成 JSON 时是对象，否则原样） */
  body: any
}

type DemoHandler = (ctx: DemoRequestContext) => unknown

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

/**
 * 把 fixture 深拷贝一份再返回。
 *
 * import 进来的 JSON 是模块级单例，整个会话里只求值一次。直接把它交给页面的话，
 * 任何一处就地修改（设置页回填后改表单、渠道弹窗往 config 里塞值）都会污染后续请求，
 * 而且刷新页面也恢复不了——模块不会重新求值。
 *
 * 与 createFallbackBody() 每次返回新对象是同一条理由。
 */
function cloneFixture<T>(fixture: T): T {
  return structuredClone(fixture)
}

/** 演示剧本里的任务规模。P1 铺 /tasks 列表 fixture 时要与这两个数对齐，别各写各的。 */
const DEMO_TASK_COUNT = 14
const DEMO_RUNNING_TASKS = 2

/**
 * 执行日志状态码，取值必须与 server/model/task_log.go:8-11 一致。
 * 仪表盘用它区分成功 / 失败 / 运行中 / 已终止（dashboard/index.vue:47-50）。
 */
const LOG_STATUS_SUCCESS = 0
const LOG_STATUS_FAILED = 1
const LOG_STATUS_RUNNING = 2
const LOG_STATUS_ABORTED = 3

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 7 天一轮的趋势基准（分布刻意做得不规整，比等差数列更像真实运维数据）。
 * 区间超过 7 天时按下标取模循环，保证 30 天区间每一格也都有非零数据。
 */
const TREND_SUCCESS = [176, 187, 170, 194, 181, 209, 191]
const TREND_FAILED = [6, 9, 4, 11, 7, 5, 8]
const TREND_ABORTED = [1, 0, 2, 1, 0, 1, 2]

/** 与 server/handler/system.go 的 DailyStat 同形状 */
interface DemoDailyStat {
  /** `MM-DD`，与后端 `day.Format("01-02")` 一致 */
  date: string
  success: number
  failed: number
  aborted: number
}

/**
 * 生成截止到今天、长度为 days 的每日统计。
 *
 * ⚠️ 字段形状必须与 server/handler/system.go:165-183 的 DailyStat 完全一致：
 *    `date` 是 `MM-DD`（不是 `YYYY-MM-DD`）、有 `aborted`、**没有** `total`。
 *    web/mock-server.mjs:19-25 里那份 daily_stats 是早就和后端漂移掉的旧形状，别照抄——
 *    它多了一个 total、少了 aborted、日期还是 10 位的。
 *    趋势图的「执行总数」是 success + failed + aborted 现算的
 *    （ExecutionTrendChart.vue:102-104），多给一个 total 既不会被读到，
 *    还会让后来的人误以为它是权威值。
 *
 * 取样下标按「距 1970-01-01 的绝对天数」取模，而不是按窗口内位置取模：
 * 后者会让同一个日历日在「近 7 天」和「近 30 天」下取到不同的数，
 * 访客切一下区间，今天的成功率就跟着跳，看起来像数据在乱变。
 */
function buildDailyStats(days: number): DemoDailyStat[] {
  const stats: DemoDailyStat[] = []
  // 今天所处的绝对天序号；减去 offset 后依然为正，不会踩 JS 负数取模
  const todayIndex = Math.floor(Date.now() / DAY_MS)

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * DAY_MS)
    const slot = (todayIndex - offset) % TREND_SUCCESS.length
    stats.push({
      // 用本地时间取月日，与后端按 now.Location() 划分自然日的口径一致
      date: `${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
      success: TREND_SUCCESS[slot] ?? 180,
      failed: TREND_FAILED[slot] ?? 5,
      aborted: TREND_ABORTED[slot] ?? 1,
    })
  }
  return stats
}

/**
 * 「最近执行任务」表格的剧本。
 *
 * 字段名照抄 server/model/task_log.go:32-54 的 ToDict()——仪表盘表格读的是
 * task_name / status / created_at / duration / task_type / labels，
 * 少一个就会出现「未命名任务」或空白列。
 *
 * 两点刻意为之：
 * 1. 覆盖全部四种状态，让表头那排「全部 / 成功 / 失败 / 终止 / 运行中」筛选每一档都有内容
 *    （dashboard/index.vue:414-426 是先过滤全量再取前 5 条）；
 * 2. 运行中的两条 duration 给 null，与「运行中的任务 = 2」那张卡片对得上；
 *    其余条目都带 duration，否则「平均执行时长」会显示 `-`
 *    （dashboard/index.vue:462-469 在没有任何可用样本时返回 null）。
 *
 * 时间用「距现在多少分钟」现算，保证任何时候打开演示站，看到的都是刚刚发生的执行。
 */
const RECENT_LOG_SEED: Array<{
  taskId: number
  name: string
  status: number
  duration: number | null
  minutesAgo: number
  taskType: string
  labels: string[]
}> = [
  { taskId: 8, name: '系统健康检查', status: LOG_STATUS_RUNNING, duration: null, minutesAgo: 1, taskType: 'cron', labels: ['监控'] },
  { taskId: 11, name: '监控指标采集', status: LOG_STATUS_RUNNING, duration: null, minutesAgo: 3, taskType: 'cron', labels: ['监控'] },
  { taskId: 3, name: '同步配置文件', status: LOG_STATUS_SUCCESS, duration: 5.4, minutesAgo: 12, taskType: 'cron', labels: ['配置'] },
  { taskId: 12, name: '证书到期巡检', status: LOG_STATUS_FAILED, duration: 31.8, minutesAgo: 38, taskType: 'cron', labels: ['监控'] },
  { taskId: 1, name: '每日数据备份', status: LOG_STATUS_SUCCESS, duration: 184.6, minutesAgo: 95, taskType: 'cron', labels: ['备份'] },
  { taskId: 9, name: '离线报表导出', status: LOG_STATUS_ABORTED, duration: 62, minutesAgo: 143, taskType: 'manual', labels: [] },
  { taskId: 2, name: '清理临时文件', status: LOG_STATUS_SUCCESS, duration: 2.1, minutesAgo: 205, taskType: 'cron', labels: [] },
  { taskId: 7, name: '发送运营日报', status: LOG_STATUS_SUCCESS, duration: 3.8, minutesAgo: 268, taskType: 'cron', labels: ['通知'] },
  { taskId: 5, name: '更新 IP 数据库', status: LOG_STATUS_SUCCESS, duration: 8.7, minutesAgo: 402, taskType: 'startup', labels: [] },
]

function buildRecentLogs() {
  return RECENT_LOG_SEED.map((seed, index) => {
    const createdAt = new Date(Date.now() - seed.minutesAgo * 60 * 1000)
    // 运行中的日志还没结束，ended_at 留空；其余按 duration 反推结束时间
    const endedAt = seed.duration == null ? null : new Date(createdAt.getTime() + seed.duration * 1000)
    return {
      id: index + 1,
      task_id: seed.taskId,
      task_name: seed.name,
      task_type: seed.taskType,
      labels: [...seed.labels],
      task: { task_type: seed.taskType, labels: [...seed.labels] },
      status: seed.status,
      duration: seed.duration,
      content: '',
      log_path: '',
      started_at: createdAt.toISOString(),
      ended_at: endedAt ? endedAt.toISOString() : null,
      created_at: createdAt.toISOString(),
      updated_at: (endedAt ?? createdAt).toISOString(),
    }
  })
}

/**
 * P0 阶段的端点表：只覆盖「不铺就进不去面板」的那几个。
 *
 * 响应体写的就是后端 JSON body 本身，**不要再包一层**——
 * request.ts 的响应拦截器 `return response.data`，页面拿到的已经是这里写的对象。
 *
 * 业务数据（任务、日志、脚本、环境变量……）与由 Go registry 导出的 schema fixture
 * 属于后续阶段，未铺到的端点一律走 createFallbackBody()。
 */
const exactRoutes: Record<string, DemoHandler> = {
  // ---- 登录与会话 ----------------------------------------------------------
  // need_init:false 才会走「登录」而不是「初始化管理员」流程
  'GET /auth/check-init': () => ({ need_init: false }),

  // enabled:false 会让 login/index.vue 提前 return，
  // 从而【阻止极验 SDK 的 <script src="https://static.geetest.com/..."> 被注入】。
  // 那是 script 标签注入，不走 fetch/XHR，任何网络层 mock 都拦不住；
  // 演示站没有后端，SDK 一旦被注入就会卡在「极验 SDK 加载失败」上，登录直接走不下去。
  'GET /auth/captcha-config': () => ({
    enabled: false,
    captcha_id: '',
    configured: false,
    implemented: false,
    required: false,
    require_after_failures: 0,
    message: '',
  }),

  // 唯一的硬阻塞：router.beforeEach 在没有 user 时会 await fetchUser()，
  // 这里失败会 clearAuth() 并打回登录页，15 个页面一个都进不去。
  'GET /auth/user': () => ({ user: DEMO_USER }),

  'POST /auth/login': () => ({
    message: '登录成功',
    access_token: DEMO_ACCESS_TOKEN,
    refresh_token: DEMO_REFRESH_TOKEN,
    user: DEMO_USER,
  }),
  'POST /auth/logout': () => ({ message: '已退出登录' }),
  // 走的是 api/auth.ts 里那个裸全局 axios（见文件末尾的双实例挂载说明）
  'POST /auth/refresh': () => ({ access_token: DEMO_ACCESS_TOKEN }),

  // ---- 面板基础信息 --------------------------------------------------------
  'GET /system/version': () => ({ data: { version: DEMO_PANEL_VERSION } }),
  'GET /system/public-version': () => ({ version: DEMO_PANEL_VERSION }),
  'GET /system/panel-settings': () => ({
    data: { panel_title: '呆呆面板', panel_icon: '' },
  }),

  'GET /system/info': () => ({
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
      go_version: 'go1.25.0',
    },
  }),

  // 仪表盘。这一份响应里的每个数字都会被至少一张卡片读到，且卡片之间互相印证，
  // 少给一个字段就会当场自相矛盾（详见下面各字段上的说明）。
  // 字段清单对齐 server/handler/system.go:185-205。
  'GET /system/dashboard': (ctx) => {
    // 趋势区间由 range 决定，合法范围与后端一致（system.go:158-163：1 ≤ n ≤ 90）
    const range = Number.parseInt(ctx.params['range'] ?? '', 10)
    const days = Number.isFinite(range) && range > 0 && range <= 90 ? range : 7

    // 多算一天：「较昨日」那几个对比卡片需要窗口外的前一天，
    // range=1 时窗口里根本没有「昨天」，直接取 dailyStats[length-2] 会是 undefined。
    // days ≥ 1 恒成立，所以 series 至少有 2 项，下面两个非空断言是可证明安全的。
    const series = buildDailyStats(days + 1)
    const dailyStats = series.slice(1)
    const today = series[series.length - 1]!
    const yesterday = series[series.length - 2]!

    // 后端 today_logs 数的是当天全部日志行（含 status=running 那几条），
    // 而 daily_stats 只统计已结束的三类，所以这里要把运行中的补回去，
    // 否则「今日执行」会比同页三段占比条的当日合计还小。
    const todayLogs = today.success + today.failed + today.aborted + DEMO_RUNNING_TASKS
    const yesterdayLogs = yesterday.success + yesterday.failed + yesterday.aborted

    return {
      data: {
        task_count: DEMO_TASK_COUNT,
        enabled_tasks: DEMO_TASK_COUNT - DEMO_RUNNING_TASKS - 1,
        running_tasks: DEMO_RUNNING_TASKS,
        // 「任务总数」卡片的增量 = task_count - prev_task_count。
        // 不给 prev_task_count 会退化成 0，卡片显示「+14」，
        // 等于说 14 个任务全是今天建的，与「用了一阵子」的剧本对不上。
        prev_task_count: DEMO_TASK_COUNT - 1,
        today_logs: todayLogs,
        success_logs: today.success,
        // failed_logs / aborted_logs 缺一不可：成功率卡片算的是
        // success_logs / (success_logs + failed_logs)（dashboard/index.vue:180-186），
        // 少了 failed_logs 会恒等于 100.0%，与同页「执行统计」里 96% 的成功占比直接打架。
        failed_logs: today.failed,
        aborted_logs: today.aborted,
        // 「较昨日」的四个对比值，缺了会让所有增量都变成「与 0 相比」，
        // 成功率卡片直接显示 +100%。
        yesterday_logs: yesterdayLogs,
        yesterday_success: yesterday.success,
        yesterday_failed: yesterday.failed,
        yesterday_aborted: yesterday.aborted,
        env_count: 18,
        sub_count: 3,
        daily_stats: dailyStats,
        recent_logs: buildRecentLogs(),
        range_days: days,
      },
    }
  },

  // 类型是 SystemHealthSnapshot，页面直接读 .items，走兜底体会拿到 undefined
  'GET /system/health-check': () => ({
    items: [{ name: '面板服务', status: 'ok', message: '演示环境运行中' }],
    last_checked_at: isoNow(),
  }),

  // ---- 由服务端 registry 导出的 schema fixture ------------------------------
  // 这两个响应体就是生成器写出来的 JSON 本身（已经是 { data: ... } 这层后端 body），
  // 不要再包一层——request.ts:50 的响应拦截器返回的是 response.data。

  // 全部通知渠道及其字段定义。新建 / 编辑渠道弹窗的输入框完全靠它渲染
  //（notifications/index.vue:141 拿 fields 生成表单），拿不到就是一张空表单。
  'GET /notifications/types': () => cloneFixture(notificationTypesFixture),

  // configApi.list 的类型是 { data: SystemConfigMap }，是「键 -> 配置项」的对象而不是数组。
  // fixture 是「全新安装、system_configs 表一行都没有」时的响应：每项的 value 等于
  // 注册表里的 default_value（依据 server/handler/config.go:87-89）。
  // 设置页 6 个 tab 的表单、以及按 schema 兜底渲染的 ExtraConfigCard 都读它。
  'GET /configs': () => cloneFixture(configsFixture),

  // 这两个端点返回的是【裸数组】，不是 { data: [...] } 信封
  //（api/taskView.ts:38 与 api/task.ts:130 的返回类型可以佐证）。
  // 兜底体是对象，页面上的 .map / .filter 会直接抛错，必须单独列出来。
  // 同类的还有 GET /tasks/{id}/log-files，因为带路径变量放在下面的 patternRoutes 里。
  'GET /tasks/views': () => [],
  'GET /tasks/cron/templates': () => [],
}

/** 路径带变量的端点：按顺序匹配，命中即返回 */
const patternRoutes: Array<{ method: string; pattern: RegExp; handler: DemoHandler }> = [
  // GET /tasks/{id}/log-files 同样返回裸数组
  { method: 'GET', pattern: /^\/tasks\/[^/]+\/log-files$/, handler: () => [] },
]

function resolveHandler(method: string, path: string): DemoHandler | null {
  const exact = exactRoutes[`${method} ${path}`]
  if (exact) return exact

  for (const route of patternRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      return route.handler
    }
  }
  return null
}

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

  return { method, path: stripApiPrefix(pathPart), params, body: parseBody(config.data) }
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

const demoAdapter: AxiosAdapter = async (config) => {
  // 整段包 try/catch：这是「绝不逃逸出 200」这条规则的最后一道闸。
  // adapter 抛出的异常会被 axios 当成网络错误，error.response 是 undefined，
  // request.ts 的拦截器识别不出来只能原样 reject，页面弹红条——
  // 演示站里任何一个 handler 写错都不该让访客看见错误。
  let body: unknown
  try {
    const ctx = normalizeRequest(config)
    const handler = resolveHandler(ctx.method, ctx.path)

    if (!handler) {
      // 打一条 debug 方便后续补端点；这里【不能】抛错或返回非 2xx，见 createFallbackBody 的说明
      console.debug('[demo] 未铺设的端点，返回空数据兜底:', ctx.method, ctx.path)
    }

    body = handler ? handler(ctx) : createFallbackBody()
  } catch (error) {
    console.error('[demo] mock 端点执行出错，已回落到空数据兜底:', config.url, error)
    body = createFallbackBody()
  }

  await delay(DEMO_LATENCY_MS)
  return buildResponse(config, body)
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
}
