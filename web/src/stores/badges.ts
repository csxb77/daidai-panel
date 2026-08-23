import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { systemApi, type SystemBadges } from '@/api/system'
import { useAuthStore } from '@/stores/auth'

/** 轮询间隔。角标不是实时监控，30s 足够；再快只会白白增加请求量。 */
const POLL_INTERVAL = 30_000

/**
 * 页面重新可见后的补刷延迟。
 * 切回标签页时立刻发请求会和 keep-alive 页面自身的 onActivated 刷新撞在一起，
 * 错开一点让业务页先拿数据，角标随后跟上。
 */
const RESUME_DELAY = 300

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

  let timer: ReturnType<typeof setInterval> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let started = false

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
  }

  /** 由调用过 checkUpdate 的页面回填，见上方 updateAvailable 的说明。 */
  function noteUpdateAvailable(value: boolean) {
    updateAvailable.value = value
  }

  /**
   * 侧栏菜单路径 → 角标配置的映射。
   *
   * `dot` 表示「只提示有事发生、不报数字」——依赖正在安装、面板有新版本属于这类，
   * 具体几个并不影响用户的下一步动作，一个点就够。
   * 其余用数字，因为「3 个失败」和「30 个失败」是两回事。
   *
   * 严重级 `danger` 用于失败类（需要用户处理），`primary` 用于进行中（只是告知）。
   */
  const menuBadges = computed<Record<string, { count: number; dot: boolean; level: 'danger' | 'primary' }>>(() => {
    const map: Record<string, { count: number; dot: boolean; level: 'danger' | 'primary' }> = {}
    const c = counts.value

    if (c.tasks_running > 0) {
      map['/tasks'] = { count: c.tasks_running, dot: false, level: 'primary' }
    }
    if (c.logs_failed_today > 0) {
      map['/logs'] = { count: c.logs_failed_today, dot: false, level: 'danger' }
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
  }
})
