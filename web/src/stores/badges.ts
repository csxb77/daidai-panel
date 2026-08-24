import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { systemApi, type SystemBadges } from '@/api/system'
import { useAuthStore } from '@/stores/auth'
import { formatDate } from '@/utils/datetime'

/** 轮询间隔。角标不是实时监控，30s 足够；再快只会白白增加请求量。 */
const POLL_INTERVAL = 30_000

/**
 * 页面重新可见后的补刷延迟。
 * 切回标签页时立刻发请求会和 keep-alive 页面自身的 onActivated 刷新撞在一起，
 * 错开一点让业务页先拿数据，角标随后跟上。
 */
const RESUME_DELAY = 300

/**
 * 失败日志角标「已读水位」的持久化 key。
 * 值是 `{ u: 用户名, d: 本地日期 YYYY-MM-DD, n: 已读到的失败数 }`。
 * 带 u 是因为同一台机器可能换账号登入，带 d 是因为服务端的 logs_failed_today
 * 本身就是按「今天」统计的，跨天后旧水位的基数已经失效。
 */
const LOGS_ACKED_KEY = 'dd:badges:logs_acked'

/** 已读水位按用户隔离。拿不到用户时用空串——它必然与存档里的名字对不上，等价于「没读过」。 */
function currentUsername(): string {
  return useAuthStore().user?.username || ''
}

/**
 * 读取失败角标的已读水位。
 *
 * 只认「同一个用户 + 同一个本地日期」的存档，对不上一律当 0：
 * 宁可多提醒一次，也不要因为沿用了别人的/昨天的水位而漏掉真实失败。
 * 日期用 utils/datetime 的 formatDate，与全站同一套本地时区口径。
 */
function loadLogsAcked(username: string): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(LOGS_ACKED_KEY)
    if (!raw) return 0
    // JSON.parse 的结果可能是 null / 数字 / 结构完全对不上的旧值，
    // 下面每一步都按「取不到就当没读过」处理，不额外做类型断言
    const saved = JSON.parse(raw) as { u?: string; d?: string; n?: number } | null
    if (!saved || saved.u !== username || saved.d !== formatDate(new Date())) return 0
    const n = Number(saved.n)
    // 存档可能被手工改过或是旧版本写的，非数字/负数一律退回 0
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    // 隐私模式下 localStorage 读取会直接抛错，JSON 也可能是坏的。
    // 角标不是主功能，读不出来就按「没读过」处理，不能让它把 store 初始化整块带崩。
    return 0
  }
}

function saveLogsAcked(username: string, n: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      LOGS_ACKED_KEY,
      JSON.stringify({ u: username, d: formatDate(new Date()), n })
    )
  } catch {
    // 隐私模式 / 存储配额满：写失败只意味着刷新后角标会再提醒一次，不值得打断用户
  }
}

function emptyBadges(): SystemBadges {
  return {
    tasks_running: 0,
    logs_failed_today: 0,
    subs_failed: 0,
    deps_failed: 0,
    deps_installing: 0,
  }
}

/**
 * 侧栏菜单角标的数据源。
 *
 * 【为什么要有可见性守卫】
 * 面板是那种「开一个标签页挂一天」的工具。没有守卫的话，一个后台标签页每天会安静地
 * 发 2880 次请求；用户开三个标签页就是三倍。document.hidden 时停表、可见时补刷一次，
 * 既不丢时效性也不空转。
 *
 * 【为什么请求失败不清空计数】
 * 角标清零和「真的没有异常」在视觉上完全一样。网络抖一下就把「3 个失败任务」的角标
 * 抹掉，是比不显示更糟的错误信息。失败时保留上一次的值，只在成功时整体替换。
 */
export const useBadgesStore = defineStore('badges', () => {
  const counts = ref<SystemBadges>(emptyBadges())

  /**
   * 「面板有新版本」。
   *
   * 刻意【不】放进 /system/badges：检查更新每次都要打一发 GitHub 外网请求且服务端无缓存，
   * 挂进 30s 轮询等于替用户持续刷 GitHub，可能触发匿名限流，把真正的「检查更新」拖垮。
   * 这一项由已经会调 checkUpdate 的页面（概览卡片、系统设置）在拿到结果后回填。
   */
  const updateAvailable = ref(false)

  /** 首次加载完成前不渲染角标，避免 0 → 3 的跳变 */
  const loaded = ref(false)

  /**
   * 失败日志角标的「已读水位」。
   *
   * 【为什么不直接把 counts.logs_failed_today 改成 0】
   * refresh() 是整体替换 counts，最多 30 秒轮询就把数字打回来，
   * 表现成「角标自己复活」，用户只会当成 bug。所以抑制状态必须独立于计数存在。
   * 显示值 = max(0, logs_failed_today − 水位)，当天再有新失败仍然会提醒。
   */
  const logsFailedAcked = ref(0)

  /**
   * 「进过执行日志页，但那一刻角标数据还没拉到」。
   * 直接 F5 停在执行日志页时会走到这里：页面的 onMounted 比 badges 的首发请求早，
   * 此刻 counts 还全是 0，按 0 记水位等于没记，第一发数据回来角标照样会亮。
   */
  let ackLogsPending = false

  let timer: ReturnType<typeof setInterval> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let started = false

  /** 已读水位的唯一写入口：内存与存档必须成对更新，否则 F5 后水位会回到旧值。 */
  function setLogsAcked(n: number) {
    logsFailedAcked.value = n
    saveLogsAcked(currentUsername(), n)
  }

  async function refresh() {
    // 防重入：慢网络下上一发还没回来时不再叠加请求
    if (inFlight) return
    const authStore = useAuthStore()
    if (!authStore.isLoggedIn) return

    inFlight = true
    try {
      const res = await systemApi.badges()
      if (res?.data) {
        counts.value = { ...emptyBadges(), ...res.data }
        loaded.value = true

        if (ackLogsPending) {
          // 补记进页时没能记上的那一笔（见 ackLogsPending 的说明）
          ackLogsPending = false
          setLogsAcked(counts.value.logs_failed_today)
        } else if (counts.value.logs_failed_today < logsFailedAcked.value) {
          // 今日失败数只会在跨零点归零、或用户删掉失败日志时变小。
          // 这时水位必须跟着降下来，否则第二天要攒够超过昨天的数量才会重新提醒。
          setLogsAcked(counts.value.logs_failed_today)
        }
      }
    } catch {
      // 静默：401 已由 request 拦截器接管跳转，其余错误保留上一次的计数。
      // 角标不是主功能，不该为它弹提示打断用户。
    } finally {
      inFlight = false
    }
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') {
      clearTimer()
      return
    }
    // 回到前台：先补刷一次，再把表重新拨上
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      void refresh()
      startTimer()
    }, RESUME_DELAY)
  }

  function startTimer() {
    clearTimer()
    timer = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL)
  }

  function clearTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 由 MainLayout 在挂载时调用。重复调用是安全的。 */
  function start() {
    if (started) return
    started = true
    // 恢复上次的已读水位。不恢复的话 F5 等于「全部未读」，刚清掉的角标又会亮起来。
    // 放在 start() 而不是 store 创建时：路由守卫已在布局挂载前 await 过 fetchUser，
    // 到这里才拿得到用户名，否则存档必然按「用户对不上」被丢弃。
    logsFailedAcked.value = loadLogsAcked(currentUsername())
    void refresh()
    startTimer()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
  }

  /** 退出登录 / 卸载布局时调用，避免登录页仍在轮询受保护接口。 */
  function stop() {
    started = false
    clearTimer()
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    counts.value = emptyBadges()
    updateAvailable.value = false
    loaded.value = false
    // 已读水位一并清掉：换个账号登入不该继承上一个人的「看过了」。
    // 存档本身按用户名隔离，所以不用删 localStorage——同一个人再登回来仍然记得。
    logsFailedAcked.value = 0
    ackLogsPending = false
  }

  /** 由调用过 checkUpdate 的页面回填，见上方 updateAvailable 的说明。 */
  function noteUpdateAvailable(value: boolean) {
    updateAvailable.value = value
  }

  /**
   * 「失败日志已经看过了」。由执行日志页在进入时回填。
   *
   * ⚠️ 调用方两处都要写：MainLayout 的 keep-alive 是 `:max="14"`，
   * 第二次以后进执行日志页只触发 onActivated、不再触发 onMounted，只写一处会只有首访生效。
   * 本函数幂等，重复调用只是把水位写成同一个值。
   */
  function ackLogsFailed() {
    if (!loaded.value) {
      ackLogsPending = true
      return
    }
    setLogsAcked(counts.value.logs_failed_today)
  }

  /**
   * 侧栏菜单路径 → 角标配置的映射。
   *
   * `dot` 表示「只提示有事发生、不报数字」——依赖正在安装、面板有新版本属于这类，
   * 具体几个并不影响用户的下一步动作，一个点就够。
   * 其余用数字，因为「3 个失败」和「30 个失败」是两回事。
   *
   * 严重级 `danger` 用于失败类（需要用户处理），`primary` 用于进行中（只是告知）。
   *
   * 执行日志那一支的语义是【未读的新失败】而不是【今日失败总数】：进过页面就算看过了，
   * 之后只报新增的部分，数到 0 就整条不放进 map——展开态的数字与收起态的方点都靠
   * `badgeOf(path)` 是否存在来决定渲染，一起消失才不会剩个孤零零的红点。
   */
  const menuBadges = computed<Record<string, { count: number; dot: boolean; level: 'danger' | 'primary' }>>(() => {
    const map: Record<string, { count: number; dot: boolean; level: 'danger' | 'primary' }> = {}
    const c = counts.value

    if (c.tasks_running > 0) {
      map['/tasks'] = { count: c.tasks_running, dot: false, level: 'primary' }
    }
    const logsFailedUnread = Math.max(0, c.logs_failed_today - logsFailedAcked.value)
    if (logsFailedUnread > 0) {
      map['/logs'] = { count: logsFailedUnread, dot: false, level: 'danger' }
    }
    if (c.subs_failed > 0) {
      map['/subscriptions'] = { count: c.subs_failed, dot: false, level: 'danger' }
    }
    // 依赖页两种状态择一显示：失败优先于「安装中」，因为失败需要用户介入。
    if (c.deps_failed > 0) {
      map['/deps'] = { count: c.deps_failed, dot: false, level: 'danger' }
    } else if (c.deps_installing > 0) {
      map['/deps'] = { count: c.deps_installing, dot: true, level: 'primary' }
    }
    if (updateAvailable.value) {
      map['/admin/settings'] = { count: 0, dot: true, level: 'danger' }
    }

    return map
  })

  return {
    counts,
    updateAvailable,
    loaded,
    menuBadges,
    refresh,
    start,
    stop,
    noteUpdateAvailable,
    ackLogsFailed,
  }
})
