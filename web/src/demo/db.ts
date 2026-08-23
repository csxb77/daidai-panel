import type {
  DemoDbState,
  DemoEnvVar,
  DemoTask,
  DemoTaskLog,
} from './types'
import {
  LOG_STATUS_ABORTED,
  LOG_STATUS_FAILED,
  LOG_STATUS_RUNNING,
  LOG_STATUS_SUCCESS,
  TASK_STATUS_DISABLED,
  TASK_STATUS_ENABLED,
  TASK_STATUS_RUNNING,
} from './types'
import { createSeedState, logStatusOfKind } from './fixtures/business'

/**
 * 在线演示 Demo 的可写数据层。
 *
 * 设计要点：
 *   1. **纯内存，不做任何持久化**。演示站对外承诺的就是「刷新页面即恢复初始数据」
 *      （横幅、README、issue #96 的回复都是这么写的），而 sessionStorage
 *      在刷新后是【保留】的 —— 只有关标签页才清空，用它就会和承诺对不上。
 *      模块级变量随页面文档一起销毁，刷新即回到初始 fixture，语义天然对齐。
 *      顺带省掉了 schema 版本号、隐私模式 / 配额兜底、每次 mutation 全量序列化
 *      （fixture 已是数千条日志的量级）这一整块只为持久化存在的代码。
 *   2. **登录态不在这里**：access_token / refresh_token 在 localStorage 里，
 *      由 auth store 管理。刷新后访客仍然是登录着的，只是数据回到初始状态。
 *   3. **所有汇总数字都从这里的事实现算**，不写死常量。
 *      仪表盘、执行统计、任务列表读的是同一批 tasks / logs，
 *      所以「总执行数 1367 但日志列表 0 条」这类自相矛盾在结构上就不可能出现。
 */

const DAY_MS = 24 * 60 * 60 * 1000

let state: DemoDbState | null = null

/** 取当前数据库。第一次调用时播种，之后一直复用同一个内存对象。 */
export function db(): DemoDbState {
  if (!state) state = createSeedState()
  return state
}

/**
 * 重置成初始 fixture（横幅上的「重置演示数据」按钮走这里）。
 *
 * 刷新页面也能达到同样效果；这个按钮提供的是「会话中途主动重置」的能力。
 * 注意 createSeedState() 每次都以调用时刻为基准重算时间，所以重置之后
 * 拿到的不是同一份旧数据，而是一台「刚刚还在干活」的面板。
 */
export function resetDb() {
  state = createSeedState()
}

/** 各表共用的自增游标，保证新建对象不会和播种数据的 id 撞车 */
export function nextId(table: string): number {
  const current = db()
  const next = (current.seq[table] ?? 0) + 1
  current.seq[table] = next
  return next
}

export function nowIso() {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 取本地时区的当天零点，与后端按 now.Location() 划分自然日的口径一致 */
function startOfLocalDay(ms: number) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `MM-DD`，与后端 DailyStat 的 `day.Format("01-02")` 一致（不是 10 位日期） */
function monthDayKey(ms: number) {
  const date = new Date(ms)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseIntOr(raw: string | undefined, fallback: number) {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

function isTruthyFlag(raw: string | undefined) {
  const value = (raw ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export interface PaginatedBody<T> {
  data: T[]
  total: number
  page: number
  page_size: number
}

/**
 * 统一的分页信封，形状照抄 server/pkg/response/response.go 的 Paginated：
 * `{ data, total, page, page_size }`，**不要再包一层**——
 * request.ts:50 的响应拦截器返回的就是这里的对象本身。
 *
 * all=1 的语义与服务端一致：一次性返回全部，page 固定 1、page_size 等于返回条数。
 */
export function paginate<T>(rows: T[], params: Record<string, string>): PaginatedBody<T> {
  if (isTruthyFlag(params['all'])) {
    return { data: rows, total: rows.length, page: 1, page_size: rows.length }
  }

  const page = Math.max(1, parseIntOr(params['page'], 1))
  let pageSize = parseIntOr(params['page_size'], 20)
  if (pageSize < 1 || pageSize > 100) pageSize = 20

  const start = (page - 1) * pageSize
  return {
    data: rows.slice(start, start + pageSize),
    total: rows.length,
    page,
    page_size: pageSize,
  }
}

function includesIgnoreCase(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

// ---------------------------------------------------------------------------
// cron 下次执行时间
// ---------------------------------------------------------------------------

// 解析一个 cron 字段。支持通配符、带步长的通配符、区间（可带步长）、逗号枚举与纯数字。
// 解析不了返回 null —— 调用方据此放弃计算 next_run_at（列表页会显示 `-`），
// 而不是瞎给一个时间：演示环境里显示错的下次执行时间比不显示更糟。
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const chunk = part.trim()
    if (!chunk) return null

    const [rangePart = '', stepPart] = chunk.split('/')
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10)
    if (!Number.isFinite(step) || step < 1) return null

    let from = min
    let to = max
    if (rangePart !== '*') {
      const bounds = rangePart.split('-')
      const start = Number.parseInt(bounds[0] ?? '', 10)
      if (!Number.isFinite(start)) return null
      from = start
      to = bounds.length > 1 ? Number.parseInt(bounds[1] ?? '', 10) : start
      if (!Number.isFinite(to)) return null
    }

    if (from < min || to > max || from > to) return null
    for (let value = from; value <= to; value += step) values.add(value)
  }

  return values.size > 0 ? values : null
}

/**
 * 估算接下来 count 次执行时间。
 *
 * 覆盖标准五段与「带秒」的六段（服务端两种都收，见 server/pkg/cron/cron.go 的
 * buildFields；任务表单里的 cron 模板下发的正是六段）。秒这一段直接丢掉 ——
 * 演示环境不需要精确到秒，而保留它会让「每 10 秒」这类模板在下次执行时间上
 * 显示成同一分钟内的一串重复值。`@daily` 这类别名一律返回空数组。
 *
 * 逐日筛选（先判断这一天是否命中 dom/month/dow，再在命中的日子里找时刻），
 * 所以最坏情况也只是 366 次日期判断，不会退化成逐分钟扫描。
 */
export function nextRunTimes(cronExpression: string, from: number, count: number): string[] {
  const firstLine = cronExpression
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return []

  let parts = firstLine.split(/\s+/)
  if (parts.length === 6) parts = parts.slice(1)
  if (parts.length !== 5) return []

  const minutes = parseCronField(parts[0] ?? '', 0, 59)
  const hours = parseCronField(parts[1] ?? '', 0, 23)
  const monthDays = parseCronField(parts[2] ?? '', 1, 31)
  const months = parseCronField(parts[3] ?? '', 1, 12)
  const weekDays = parseCronField(parts[4] ?? '', 0, 7)
  if (!minutes || !hours || !monthDays || !months || !weekDays) return []

  // cron 里 7 也表示周日
  if (weekDays.has(7)) weekDays.add(0)

  const domRestricted = (parts[2] ?? '*') !== '*'
  const dowRestricted = (parts[4] ?? '*') !== '*'

  const sortedHours = [...hours].sort((a, b) => a - b)
  const sortedMinutes = [...minutes].sort((a, b) => a - b)

  const result: string[] = []
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)

  for (let dayOffset = 0; dayOffset < 366 && result.length < count; dayOffset += 1) {
    const day = new Date(cursor.getTime() + dayOffset * DAY_MS)
    day.setHours(0, 0, 0, 0)

    if (!months.has(day.getMonth() + 1)) continue

    // 标准 cron：dom 与 dow 同时受限时取【并集】，只有一个受限时以它为准
    const domHit = monthDays.has(day.getDate())
    const dowHit = weekDays.has(day.getDay())
    let dayHit = true
    if (domRestricted && dowRestricted) dayHit = domHit || dowHit
    else if (domRestricted) dayHit = domHit
    else if (dowRestricted) dayHit = dowHit
    if (!dayHit) continue

    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const candidate = new Date(day)
        candidate.setHours(hour, minute, 0, 0)
        if (candidate.getTime() > from) {
          result.push(candidate.toISOString())
          if (result.length >= count) break
        }
      }
      if (result.length >= count) break
    }
  }

  return result
}

/** 下一次执行时间；算不出来返回 null（列表页会显示 `-`，好过给一个错的时间） */
export function estimateNextRun(cronExpression: string, from: number): string | null {
  return nextRunTimes(cronExpression, from, 1)[0] ?? null
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export function findTask(id: number): DemoTask | undefined {
  return db().tasks.find((task) => task.id === id)
}

function splitCronExpressions(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * 把原始标签翻译成展示标签，复刻 server/handler/task_query.go 的 buildPreparedTaskLabels：
 *   - `分组:xxx` 提到最前面；
 *   - `subscription:N` 换成订阅名（订阅已删除则显示「订阅任务」）。
 * 不翻译的话列表页会直接把 `subscription:1` 当成标签画出来。
 */
function buildDisplayLabels(labels: string[]): string[] {
  const current = db()
  const display: string[] = []
  const seen = new Set<string>()
  let groupName = ''

  const push = (label: string) => {
    const value = label.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    display.push(value)
  }

  for (const raw of labels) {
    const label = raw.trim()
    if (label.startsWith('分组:')) {
      const group = label.slice('分组:'.length).trim()
      if (group && !groupName) groupName = group
      continue
    }
    if (!label.startsWith('subscription:')) {
      push(label)
      continue
    }
    const subId = Number.parseInt(label.slice('subscription:'.length), 10)
    const subscription = current.subscriptions.find((item) => item.id === subId)
    push(subscription?.name || '订阅任务')
  }

  return groupName ? [groupName, ...display] : display
}

/** 任务列表/详情下发体，字段照抄 server/model/task.go 的 ToDict() + task_query.go 的补充字段 */
export function toTaskDict(task: DemoTask): Record<string, unknown> {
  const current = db()
  const item: Record<string, unknown> = {
    ...task,
    labels: [...task.labels],
    cron_expressions: splitCronExpressions(task.cron_expression),
    display_labels: buildDisplayLabels(task.labels),
  }

  if (task.notification_channel_id) {
    const channel = current.channels.find((item2) => item2.id === task.notification_channel_id)
    if (channel) {
      item['notification_channel_name'] = channel.name
      item['notification_channel_enabled'] = channel.enabled
    }
  }

  // 与服务端一致：只有「非禁用 + cron 类型 + 表达式非空」才给下次执行时间
  if (task.status !== TASK_STATUS_DISABLED && task.task_type === 'cron' && task.cron_expression) {
    const next = estimateNextRun(task.cron_expression, Date.now())
    if (next) item['next_run_at'] = next
  }

  return item
}

/** 默认排序：置顶优先 → 启用/运行 在前、禁用在后 → sort_order → 创建时间倒序 */
export function sortTasks(rows: DemoTask[]): DemoTask[] {
  const group = (status: number) => {
    if (status === TASK_STATUS_DISABLED) return 1
    return status === TASK_STATUS_ENABLED || status === TASK_STATUS_RUNNING || status === 0.5 ? 0 : 2
  }

  return [...rows].sort((left, right) => {
    if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1
    const groupDiff = group(left.status) - group(right.status)
    if (groupDiff !== 0) return groupDiff
    if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order
    if (left.created_at !== right.created_at) return right.created_at.localeCompare(left.created_at)
    return right.id - left.id
  })
}

/** 复刻服务端的 keyword / status / label 过滤（filters + sort_rules 那套高级筛选不在 Demo 范围内） */
export function filterTasks(params: Record<string, string>): DemoTask[] {
  let rows = db().tasks

  const keyword = (params['keyword'] ?? '').trim()
  if (keyword) {
    rows = rows.filter(
      (task) => includesIgnoreCase(task.name, keyword) || includesIgnoreCase(task.command, keyword),
    )
  }

  const statusRaw = (params['status'] ?? '').trim()
  if (statusRaw !== '') {
    const status = Number.parseFloat(statusRaw)
    if (Number.isFinite(status)) rows = rows.filter((task) => task.status === status)
  }

  const label = (params['label'] ?? '').trim()
  if (label) {
    rows = rows.filter((task) => task.labels.some((item) => includesIgnoreCase(item, label)))
  }

  return sortTasks(rows)
}

// ---------------------------------------------------------------------------
// 执行日志
// ---------------------------------------------------------------------------

/**
 * 生成日志正文。
 *
 * 正文不入库（几千条日志各存一份会把内存占用撑大一个数量级），按 kind 现算。
 * 每种结局的正文都要能自证：失败的正文里必须真的有报错行，
 * 否则演示时点开一条「失败」看到的是一片成功日志。
 */
export function buildLogContent(log: DemoTaskLog): string {
  // 假日志流跑完之后会把「刚刚滚过的那份正文」留在 log.content 上。
  // LogViewer 收到 done 之后会立刻回查 latest-log 并整体替换渲染内容
  // （LogViewer.vue:239-241），不认这份正文的话，访客会看到刚看完的日志
  // 在最后一刻被换成另一套措辞的版本。
  if (log.content) return log.content

  const task = findTask(log.task_id)
  const command = task?.command ?? '(任务已删除)'
  const stamp = (offsetSeconds: number) => {
    const at = new Date(new Date(log.started_at).getTime() + offsetSeconds * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
      + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  }

  const duration = log.duration ?? 0
  const lines: string[] = [
    `[${stamp(0)}] ## 开始执行 ${log.task_name}`,
    `[${stamp(0)}] ## 命令：${command}`,
    `[${stamp(0)}] ## 工作目录：/opt/daidai/scripts`,
    '',
  ]

  switch (log.kind) {
    case 'ok':
      lines.push(
        `[${stamp(1)}] 环境变量已注入（19 项）`,
        `[${stamp(1)}] 开始处理...`,
        // 裸 \r 是终端进度条的覆盖语义，前端的日志渲染会按覆盖处理，不要换成 \n
        `处理进度: 25%\r处理进度: 60%\r处理进度: 88%\r处理进度: 100%`,
        `[${stamp(Math.max(1, duration - 1))}] 处理完成，无异常`,
        '',
        `[${stamp(duration)}] ## 执行结束，退出码 0，耗时 ${duration}s`,
      )
      break
    case 'fail': {
      lines.push(
        `[${stamp(1)}] 环境变量已注入（19 项）`,
        `[${stamp(1)}] 开始处理...`,
      )
      // 重试相关的两行只在任务真的配了重试时才出现：
      // 一个 max_retries=0 的任务，正文里写「重试次数已用尽」当场就穿帮。
      // 同理不写死「2s 后重试」——很多任务整次执行也就一两秒。
      if ((task?.max_retries ?? 0) > 0) {
        lines.push(`[${stamp(Math.max(1, duration - 2))}] WARN  第 1 次尝试失败，准备重试`)
      }
      lines.push(`[${stamp(Math.max(1, duration - 1))}] ERROR 远端返回 502 Bad Gateway`)
      if ((task?.max_retries ?? 0) > 0) {
        lines.push(`[${stamp(Math.max(1, duration - 1))}] ERROR 重试次数已用尽，放弃本次执行`)
      }
      lines.push(
        '',
        `[${stamp(duration)}] ## 执行结束，退出码 1，耗时 ${duration}s`,
      )
      break
    }
    case 'timeout':
      lines.push(
        `[${stamp(1)}] 环境变量已注入（19 项）`,
        `[${stamp(1)}] 开始处理...`,
        `处理进度: 12%\r处理进度: 34%\r处理进度: 41%`,
        `[${stamp(duration)}] ERROR 任务超过配置的超时时间 ${task?.timeout ?? duration}s，已被面板终止`,
        '',
        `[${stamp(duration)}] ## 执行结束，退出码 -1（超时），耗时 ${duration}s`,
      )
      break
    case 'abort':
      lines.push(
        `[${stamp(1)}] 环境变量已注入（19 项）`,
        `[${stamp(1)}] 开始处理...`,
        `[${stamp(duration)}] 收到停止信号，正在清理临时文件`,
        '',
        `[${stamp(duration)}] ## 已被手动终止，耗时 ${duration}s`,
      )
      break
    case 'running':
      lines.push(
        `[${stamp(1)}] 环境变量已注入（19 项）`,
        `[${stamp(1)}] 开始处理...`,
        `[${stamp(2)}] 正在执行中，实时日志请点「查看实时日志」`,
      )
      break
  }

  return lines.join('\n')
}

/** 执行日志下发体，字段照抄 server/model/task_log.go 的 ToDict() */
export function toLogDict(log: DemoTaskLog, withContent = false): Record<string, unknown> {
  const task = findTask(log.task_id)
  const labels = task ? buildDisplayLabels(task.labels) : []
  const taskType = task?.task_type ?? 'cron'

  return {
    id: log.id,
    task_id: log.task_id,
    task_name: task?.name ?? log.task_name,
    task_type: taskType,
    labels,
    task: { task_type: taskType, labels },
    status: log.status,
    duration: log.duration,
    content: withContent ? buildLogContent(log) : '',
    log_path: null,
    started_at: log.started_at,
    ended_at: log.ended_at,
    // 后端这两条由同一次写入产生，值与 started_at / ended_at 一致
    created_at: log.started_at,
    updated_at: log.ended_at ?? log.started_at,
  }
}

export function filterLogs(params: Record<string, string>): DemoTaskLog[] {
  let rows = db().logs

  const taskIdRaw = (params['task_id'] ?? '').trim()
  if (taskIdRaw) {
    const taskId = Number.parseInt(taskIdRaw, 10)
    if (Number.isFinite(taskId)) rows = rows.filter((log) => log.task_id === taskId)
  }

  const statusRaw = (params['status'] ?? '').trim()
  if (statusRaw !== '') {
    const status = Number.parseInt(statusRaw, 10)
    if (Number.isFinite(status)) rows = rows.filter((log) => log.status === status)
  }

  const keyword = (params['keyword'] ?? '').trim()
  if (keyword) {
    rows = rows.filter((log) => {
      const task = findTask(log.task_id)
      return includesIgnoreCase(task?.name ?? log.task_name, keyword)
    })
  }

  // 执行时间范围，对齐 server/handler/log.go 的 start_time / end_time（RFC3339，闭区间）。
  // 服务端筛的是 created_at；Demo 这边 created_at 就等于 started_at（见 toLogDict 的注释），
  // 所以直接拿 started_at 比就行，语义一致。
  //
  // 演示站必须真的能筛：一个点了没反应的日期选择器比没有这个功能更糟——
  // 访客会以为面板本身有问题。
  const startTime = Date.parse((params['start_time'] ?? '').trim())
  if (Number.isFinite(startTime)) {
    rows = rows.filter((log) => new Date(log.started_at).getTime() >= startTime)
  }
  const endTime = Date.parse((params['end_time'] ?? '').trim())
  if (Number.isFinite(endTime)) {
    rows = rows.filter((log) => new Date(log.started_at).getTime() <= endTime)
  }

  // 服务端是 started_at DESC；state.logs 本身就按这个顺序存，这里只在过滤后保持它
  return rows
}

/**
 * 记一条「刚刚跑完」的执行日志，并同步任务的 last_run_*。
 *
 * 手动点「运行」走这里。写完之后仪表盘的今日执行、成功数、趋势图当天那一格
 * 会一起往上跳一格——因为它们本来就是从这张表算出来的。
 */
export function appendTaskRunLog(task: DemoTask, kind: DemoTaskLog['kind'], durationSeconds: number): DemoTaskLog {
  const current = db()
  const startedAt = Date.now() - Math.round(durationSeconds * 1000)
  const status = logStatusOfKind(kind)

  const log: DemoTaskLog = {
    id: nextId('log'),
    task_id: task.id,
    task_name: task.name,
    status,
    duration: kind === 'running' ? null : Math.round(durationSeconds * 10) / 10,
    started_at: new Date(startedAt).toISOString(),
    ended_at: kind === 'running' ? null : new Date(startedAt + durationSeconds * 1000).toISOString(),
    kind,
  }

  current.logs.unshift(log)
  task.last_run_at = log.started_at
  task.last_run_status = status === LOG_STATUS_RUNNING ? null : status
  task.last_running_time = log.duration
  task.updated_at = nowIso()
  return log
}

// ---------------------------------------------------------------------------
// 仪表盘 / 系统统计
// ---------------------------------------------------------------------------

interface DailyBucket {
  success: number
  failed: number
  aborted: number
  total: number
}

/** 把全部日志按本地自然日分桶，仪表盘的每日趋势与今日/昨日对比都读它 */
function bucketLogsByDay(): Map<string, DailyBucket> {
  const buckets = new Map<string, DailyBucket>()

  for (const log of db().logs) {
    const key = monthDayKey(new Date(log.started_at).getTime())
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { success: 0, failed: 0, aborted: 0, total: 0 }
      buckets.set(key, bucket)
    }
    bucket.total += 1
    if (log.status === LOG_STATUS_SUCCESS) bucket.success += 1
    else if (log.status === LOG_STATUS_FAILED) bucket.failed += 1
    else if (log.status === LOG_STATUS_ABORTED) bucket.aborted += 1
  }

  return buckets
}

const EMPTY_BUCKET: DailyBucket = { success: 0, failed: 0, aborted: 0, total: 0 }

/**
 * GET /system/dashboard 的响应体（不含外层 `data`）。
 * 字段清单对齐 server/handler/system.go:185-205。
 *
 * ⚠️ 这里的每一个数字都是从 tasks / logs 现算的。
 *    历史上这一块出过「成功率恒 100%」的问题，根因就是各处各写一份常量。
 *    改这里时请继续保持「只算不写死」，尤其是 failed_logs / yesterday_* 这几个
 *    ——少下发一个，前端的对比卡片就会拿 0 去比，直接显示 +100%。
 */
export function buildDashboard(params: Record<string, string>): Record<string, unknown> {
  const current = db()
  const requested = parseIntOr(params['range'], 7)
  const rangeDays = requested > 0 && requested <= 90 ? requested : 7

  const buckets = bucketLogsByDay()
  const todayStart = startOfLocalDay(Date.now())

  const dailyStats: Array<{ date: string; success: number; failed: number; aborted: number }> = []
  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const key = monthDayKey(todayStart - offset * DAY_MS)
    const bucket = buckets.get(key) ?? EMPTY_BUCKET
    dailyStats.push({ date: key, success: bucket.success, failed: bucket.failed, aborted: bucket.aborted })
  }

  const today = buckets.get(monthDayKey(todayStart)) ?? EMPTY_BUCKET
  const yesterday = buckets.get(monthDayKey(todayStart - DAY_MS)) ?? EMPTY_BUCKET

  return {
    task_count: current.tasks.length,
    enabled_tasks: current.tasks.filter((task) => task.status === TASK_STATUS_ENABLED).length,
    running_tasks: current.tasks.filter((task) => task.status === TASK_STATUS_RUNNING).length,
    // 「任务总数」卡片的增量 = task_count - prev_task_count，按「今天之前建的任务数」算
    prev_task_count: current.tasks.filter((task) => new Date(task.created_at).getTime() < todayStart).length,
    // 后端 today_logs 数的是当天全部日志行，含 status=running 那几条，
    // 所以它会比同页三段占比条的当日合计（只算已结束的三类）大一点，这是对的
    today_logs: today.total,
    success_logs: today.success,
    failed_logs: today.failed,
    aborted_logs: today.aborted,
    yesterday_logs: yesterday.total,
    yesterday_success: yesterday.success,
    yesterday_failed: yesterday.failed,
    yesterday_aborted: yesterday.aborted,
    env_count: current.envs.length,
    sub_count: current.subscriptions.length,
    daily_stats: dailyStats,
    recent_logs: current.logs.slice(0, 10).map((log) => toLogDict(log)),
    range_days: rangeDays,
  }
}

/**
 * GET /system/stats 的响应体（不含外层 `data`）。
 * 系统设置页「系统概况」那六个数字读的就是它——不铺就全是 0。
 * 字段与 server/handler/system.go:230-249 一致。
 */
export function buildSystemStats(): Record<string, unknown> {
  const current = db()
  const success = current.logs.filter((log) => log.status === LOG_STATUS_SUCCESS).length
  const failed = current.logs.filter((log) => log.status === LOG_STATUS_FAILED).length
  const aborted = current.logs.filter((log) => log.status === LOG_STATUS_ABORTED).length
  // 与后端一致：成功率只看自然结束的成功/失败，主动终止不拉低成功率
  const finished = success + failed

  return {
    tasks: {
      total: current.tasks.length,
      enabled: current.tasks.filter((task) => task.status === TASK_STATUS_ENABLED).length,
      disabled: current.tasks.filter((task) => task.status === TASK_STATUS_DISABLED).length,
      running: current.tasks.filter((task) => task.status === TASK_STATUS_RUNNING).length,
    },
    logs: {
      total: current.logs.length,
      success,
      failed,
      aborted,
      success_rate: finished > 0 ? (success / finished) * 100 : 0,
    },
    scripts: {
      total: current.scriptFiles.length,
    },
  }
}

/**
 * GET /system/badges 的响应体（不含外层 `data`）。
 * 字段清单对齐 server/handler/system_badges.go。
 *
 * 同样遵守本文件「只算不写死」的规矩：五个数字全部从 tasks / logs / subscriptions / deps
 * 现算。演示站的角标必须跟着 Demo 数据走 —— 访客点「运行任务」之后，侧栏的运行中角标
 * 要真的 +1，写死常量就演不出这个联动。
 *
 * 服务端会按角色裁剪（viewer 看不到订阅/依赖），Demo 的账号恒为管理员，所以这里全量返回。
 */
export function buildSystemBadges(): Record<string, number> {
  const current = db()
  const todayStart = startOfLocalDay(Date.now())

  return {
    tasks_running: current.tasks.filter((task) => task.status === TASK_STATUS_RUNNING).length,
    logs_failed_today: current.logs.filter(
      (log) => log.status === LOG_STATUS_FAILED && new Date(log.started_at).getTime() >= todayStart
    ).length,
    // 订阅 status：0 成功 / 1 失败，与 server/service/subscription.go 的写入一致
    subs_failed: current.subscriptions.filter((sub) => sub.status === 1).length,
    deps_failed: current.deps.filter((dep) => dep.status === 'failed').length,
    deps_installing: current.deps.filter((dep) =>
      dep.status === 'queued' || dep.status === 'installing' || dep.status === 'removing'
    ).length,
  }
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_POSITION_STEP = 1000

export function isValidEnvName(name: string) {
  return ENV_NAME_PATTERN.test(name)
}

/** 逗号/分号/换行分隔的分组串 → 去重后的数组，复刻 server/model/env_var.go 的 SplitEnvGroups */
export function splitEnvGroups(value: string): string[] {
  const seen = new Set<string>()
  const groups: string[] = []
  for (const raw of value.split(/[,，;；\n\r\t]/)) {
    const group = raw.trim()
    if (!group || seen.has(group)) continue
    seen.add(group)
    groups.push(group)
  }
  return groups
}

export function joinEnvGroups(groups: string[]): string {
  return splitEnvGroups(groups.join(',')).join(',')
}

export function toEnvDict(env: DemoEnvVar): Record<string, unknown> {
  return { ...env, groups: splitEnvGroups(env.group) }
}

/** 列表顺序：sort_order DESC（置顶区在前）→ position ASC → created_at ASC → id ASC */
export function sortEnvs(rows: DemoEnvVar[]): DemoEnvVar[] {
  return [...rows].sort((left, right) => {
    if (left.sort_order !== right.sort_order) return right.sort_order - left.sort_order
    if (left.position !== right.position) return left.position - right.position
    if (left.created_at !== right.created_at) return left.created_at.localeCompare(right.created_at)
    return left.id - right.id
  })
}

export function filterEnvs(params: Record<string, string>): DemoEnvVar[] {
  let rows = db().envs

  const keyword = (params['keyword'] ?? '').trim()
  if (keyword) {
    rows = rows.filter(
      (env) => includesIgnoreCase(env.name, keyword)
        || includesIgnoreCase(env.remarks, keyword)
        || includesIgnoreCase(env.value, keyword)
        || includesIgnoreCase(env.group, keyword),
    )
  }

  const groupFilters = splitEnvGroups([params['groups'] ?? '', params['group'] ?? ''].join(','))
  if (groupFilters.length > 0) {
    rows = rows.filter((env) => {
      const groups = splitEnvGroups(env.group)
      return groupFilters.some((group) => groups.includes(group))
    })
  }

  const enabledRaw = (params['enabled'] ?? '').trim()
  if (enabledRaw !== '') {
    const enabled = enabledRaw.toLowerCase() === 'true' || enabledRaw === '1'
    rows = rows.filter((env) => env.enabled === enabled)
  }

  return sortEnvs(rows)
}

export function nextEnvPosition(sortOrder: number): number {
  const siblings = db().envs.filter((env) => env.sort_order === sortOrder)
  const max = siblings.reduce((acc, env) => (env.position > acc ? env.position : acc), 0)
  return max + ENV_POSITION_STEP
}

/**
 * 拖拽排序：把 sourceId 插到 targetId 之前；targetId 为空表示移到末尾。
 * 复刻 server/handler/env.go 的 reorderEnvWithinSortBucket。
 *
 * ⚠️ 这里必须【真的改顺序】。只回一句 `{message:'排序更新成功'}` 而不动数据，
 *    页面重新加载列表后会把行弹回原位，看起来像拖拽功能坏了。
 */
export function reorderEnv(sourceId: number, targetId?: number): { ok: true } | { ok: false; error: string } {
  const current = db()
  const source = current.envs.find((env) => env.id === sourceId)
  if (!source) return { ok: false, error: '源环境变量不存在' }
  if (targetId !== undefined && targetId === sourceId) return { ok: true }

  if (targetId !== undefined) {
    const target = current.envs.find((env) => env.id === targetId)
    if (!target) return { ok: false, error: '目标环境变量不存在' }
    if (target.sort_order !== source.sort_order) {
      return { ok: false, error: '置顶项和普通项请分别排序，需要跨区移动时请使用置顶按钮' }
    }
  }

  const bucket = sortEnvs(current.envs.filter((env) => env.sort_order === source.sort_order))
  const rest = bucket.filter((env) => env.id !== source.id)

  let insertIndex = rest.length
  if (targetId !== undefined) {
    const found = rest.findIndex((env) => env.id === targetId)
    if (found === -1) return { ok: false, error: '目标环境变量不存在' }
    insertIndex = found
  }

  const ordered = [...rest.slice(0, insertIndex), source, ...rest.slice(insertIndex)]
  ordered.forEach((env, index) => {
    env.sort_order = source.sort_order
    env.position = (index + 1) * ENV_POSITION_STEP
  })

  return { ok: true }
}

// ---------------------------------------------------------------------------
// 脚本
// ---------------------------------------------------------------------------

export interface ScriptTreeNode {
  key: string
  title: string
  isLeaf: boolean
  type: string
  children?: ScriptTreeNode[]
  extension?: string
  size?: number
  mtime?: number
}

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** 所有目录（显式建的 + 从文件路径推出来的父目录） */
function allScriptDirs(): Set<string> {
  const current = db()
  const dirs = new Set<string>(current.scriptDirs)
  for (const file of current.scriptFiles) {
    const segments = file.path.split('/')
    segments.pop()
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      dirs.add(prefix)
    }
  }
  return dirs
}

/** 目录在前、文件在后，各自按名字排序，形状照抄 server/handler/script_file_ops.go 的 buildTree */
export function buildScriptTree(prefix = ''): ScriptTreeNode[] {
  const current = db()
  const dirs = allScriptDirs()
  const depth = prefix ? prefix.split('/').length : 0

  const childDirs: ScriptTreeNode[] = []
  for (const dir of dirs) {
    if (prefix ? !dir.startsWith(`${prefix}/`) : dir.includes('/')) continue
    if (dir.split('/').length !== depth + 1) continue
    childDirs.push({
      key: dir,
      title: dir.slice(dir.lastIndexOf('/') + 1),
      isLeaf: false,
      type: 'directory',
      children: buildScriptTree(dir),
    })
  }

  const childFiles: ScriptTreeNode[] = []
  for (const file of current.scriptFiles) {
    if (prefix ? !file.path.startsWith(`${prefix}/`) : file.path.includes('/')) continue
    if (file.path.split('/').length !== depth + 1) continue
    childFiles.push({
      key: file.path,
      title: file.path.slice(file.path.lastIndexOf('/') + 1),
      isLeaf: true,
      type: 'file',
      extension: extensionOf(file.path),
      size: utf8Size(file.content),
      mtime: file.mtime,
    })
  }

  const byTitle = (left: ScriptTreeNode, right: ScriptTreeNode) =>
    left.title.toLowerCase().localeCompare(right.title.toLowerCase())

  return [...childDirs.sort(byTitle), ...childFiles.sort(byTitle)]
}

/** GET /scripts 的扁平文件列表，字段照抄 server/handler/script_file_ops.go 的 List */
export function buildScriptList(keyword: string) {
  const rows = db().scriptFiles
    .filter((file) => !keyword || includesIgnoreCase(file.path, keyword))
    .map((file) => ({
      path: file.path,
      name: file.path.slice(file.path.lastIndexOf('/') + 1),
      size: utf8Size(file.content),
      mtime: file.mtime,
    }))
  return rows.sort((left, right) => left.path.localeCompare(right.path))
}

export function findScriptFile(path: string) {
  const normalized = path.replace(/^\/+/, '')
  return db().scriptFiles.find((file) => file.path === normalized)
}

/** 保存脚本内容；文件不存在则新建（「新建脚本」走的就是这条路径） */
export function saveScriptContent(path: string, content: string) {
  const normalized = path.replace(/^\/+/, '')
  const existing = findScriptFile(normalized)
  if (existing) {
    existing.content = content
    existing.mtime = Math.floor(Date.now() / 1000)
    return existing
  }

  const created = { path: normalized, content, mtime: Math.floor(Date.now() / 1000) }
  db().scriptFiles.push(created)
  return created
}
