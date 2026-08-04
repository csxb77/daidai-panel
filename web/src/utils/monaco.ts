import loader, { type Monaco } from '@monaco-editor/loader'
import {
  getDefaultEditorBackgroundColor,
  getReadableTextColor,
  isDarkColor,
  isPanelDarkMode
} from './panelAppearance'

const MONACO_CDN_VS = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs'
const LOCAL_MONACO_VS = 'monaco/vs'
const LOCAL_MONACO_REQUIRED_FILES = [
  'loader.js',
  'editor/editor.main.js',
  'editor/editor.main.css',
  'language/css/monaco.contribution.js',
  'language/html/monaco.contribution.js',
  'language/json/monaco.contribution.js',
  'language/typescript/monaco.contribution.js',
]

/** 单个探测请求的超时。同源静态资源正常远低于此值，超时只当「没探明白」处理，不当作缺失。 */
const PROBE_TIMEOUT_MS = 5000
/** 本地初始化超时兜底：AMD require 在个别残缺场景会既不 resolve 也不 reject，必须有上限。 */
const LOCAL_INIT_TIMEOUT_MS = 20000
/** CDN 初始化超时。自建面板大量跑在无外网环境，连不上 jsdelivr 时要尽快报错，而不是让用户干等。 */
const CDN_INIT_TIMEOUT_MS = 8000
/** 超过这个耗时就按 warn 输出，方便用户不开 Verbose 也能在控制台看到「慢在哪」。 */
const SLOW_LOAD_WARN_MS = 3000

/**
 * 探测结论的会话级缓存。
 *
 * 失效策略（必须同时满足「同一部署内不重复探测」和「面板升级后能重新探测」）：
 * 1. 用 sessionStorage 而不是 localStorage —— 换标签页 / 重开浏览器一定重新探测；
 * 2. key 里带 BASE_URL —— 不同挂载路径互不串用；
 * 3. value 里带 schema 版本 + 必需文件清单签名 —— 前端升级后只要探测语义变了，旧结论自动作废；
 * 4. 只缓存「可用」这一个正向结论，且本地初始化一旦真的失败就立刻清除。
 *    负向结论（missing/unknown）永不缓存，否则升级修好资源后会在整个会话里一直绕道 CDN。
 *    正向结论即使过期也是自愈的：下次直奔本地 → 失败 → 清缓存 + 报错 → 再下次重新探测。
 */
const PROBE_CACHE_KEY = `dd:monaco-local-probe:${import.meta.env.BASE_URL}`
const PROBE_CACHE_SIGNATURE = `v1|${LOCAL_MONACO_REQUIRED_FILES.join(',')}`

type MonacoSource = 'local' | 'cdn'
/**
 * 本次结果的探测来源。
 * `reused-init` 表示这次根本没探测：loader 单例上一轮已经绑定了来源，探测结论已经影响不了加载路径。
 */
type ProbeOrigin = 'session-cache' | 'network' | 'reused-init'

/**
 * 三态探测结论：
 * - available：所有必需文件都被确认存在
 * - missing：至少有一个文件被服务端明确否认（4xx，或被 SPA fallback 成 HTML）
 * - unknown：只出现网络异常/超时，没有拿到任何「明确不存在」的证据
 *
 * unknown 不能等同 missing：连同源静态资源都在抖的网络里，跨域 CDN 只会更差。
 * 这种情况继续按本地加载，比因为一次抖动就改连 jsdelivr 成功率高得多。
 */
type ProbeVerdict = 'available' | 'missing' | 'unknown'

export interface MonacoLoadResult {
  monaco: Monaco
  source: MonacoSource
  /** 从 loadMonacoEditor() 调用到 resolve 的耗时（毫秒），用于性能观测。 */
  elapsedMs: number
  /** 本次本地资源探测结论的来源。 */
  probedFrom: ProbeOrigin
}

const MONACO_USER_MESSAGE_KEY = 'monacoUserMessage'

let monacoPromise: Promise<MonacoLoadResult> | null = null

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * 造一个带「可直接展示给用户的原因」的错误。
 * 不用 class extends Error，避免打包目标降级后 instanceof 失真，改成属性打标。
 */
function createMonacoError(userMessage: string, cause?: unknown) {
  const error = new Error(userMessage)
  Object.assign(error, { [MONACO_USER_MESSAGE_KEY]: userMessage, cause })
  return error
}

/**
 * 取出可直接展示给用户的失败原因；不是本模块抛出的错误返回空串，由调用方兜底文案。
 */
export function getMonacoLoadErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>)[MONACO_USER_MESSAGE_KEY]
    if (typeof message === 'string' && message) {
      return message
    }
  }
  return ''
}

function getLocalMonacoAssetUrl(relativePath: string) {
  return `${import.meta.env.BASE_URL}${LOCAL_MONACO_VS}/${relativePath}`
}

/**
 * 统一输出加载耗时。
 * 正常耗时走 console.debug（DevTools 默认折叠在 Verbose 里，不刷屏），
 * 超过阈值才升级成 warn，用户不开 Verbose 也能看到。
 */
function reportLoadTiming(message: string, elapsedMs: number) {
  if (elapsedMs >= SLOW_LOAD_WARN_MS) {
    console.warn(message)
    return
  }
  console.debug(message)
}

function readProbeCache() {
  try {
    return window.sessionStorage.getItem(PROBE_CACHE_KEY) === PROBE_CACHE_SIGNATURE
  } catch {
    // 隐私模式 / 禁用存储时直接当作没缓存，退化成每次探测，不影响正确性
    return false
  }
}

function writeProbeCache() {
  try {
    window.sessionStorage.setItem(PROBE_CACHE_KEY, PROBE_CACHE_SIGNATURE)
  } catch {
    // 忽略：写不进去只是少一层提速
  }
}

function clearProbeCache() {
  try {
    window.sessionStorage.removeItem(PROBE_CACHE_KEY)
  } catch {
    // 忽略
  }
}

function releaseResponseBody(response: Response) {
  try {
    const cancelling = response.body?.cancel?.()
    if (cancelling && typeof cancelling.catch === 'function') {
      cancelling.catch(() => {})
    }
  } catch {
    // body 已被消费或浏览器不支持 cancel，忽略
  }
}

/**
 * 把一次探测响应翻译成三态结论。
 *
 * 关键点：200 也可能意味着「文件不存在」。
 * Go 版面板在 monaco 目录整个缺失时，/monaco/** 没有注册静态路由，会落到 SPA fallback
 * 返回 index.html（200 + text/html）；nginx 的 try_files 在部分配置下同理。
 * 只看 response.ok 会把这种情况误判成本地可用 —— 正是 v2.2.19 那类故障的变体。
 */
function judgeProbeResponse(response: Response): ProbeVerdict {
  if (!response.ok) {
    // 5xx 更像服务端临时故障，不足以证明资源被裁掉
    return response.status >= 500 ? 'unknown' : 'missing'
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/html')) {
    return 'missing'
  }

  return 'available'
}

async function fetchProbe(url: string, method: 'HEAD' | 'GET') {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS)

  try {
    // 这里刻意不再用 cache: 'no-store'。
    // 这些资源随镜像发布、由 nginx 打上 immutable 缓存头，强制绕过缓存没有任何正确性收益，
    // 只会保证「每次进页面都必然打一轮网络」。
    return await fetch(url, { method, signal: controller?.signal ?? null })
  } finally {
    clearTimeout(timer)
  }
}

async function probeMonacoAsset(relativePath: string): Promise<ProbeVerdict> {
  const assetUrl = getLocalMonacoAssetUrl(relativePath)

  try {
    const headResponse = await fetchProbe(assetUrl, 'HEAD')
    // 405/501 = 服务端不支持 HEAD，只有这两种情况才值得再补一次 GET
    if (headResponse.status !== 405 && headResponse.status !== 501) {
      return judgeProbeResponse(headResponse)
    }
  } catch {
    // 网络异常先不下结论，交给下面的 GET 再确认一次，避免一次抖动就判本地不可用
  }

  try {
    const getResponse = await fetchProbe(assetUrl, 'GET')
    const verdict = judgeProbeResponse(getResponse)
    // 只要 header，body 立刻丢弃，避免为了探测把 editor.main.js 整个拉下来
    releaseResponseBody(getResponse)
    return verdict
  } catch {
    return 'unknown'
  }
}

async function probeLocalMonaco(): Promise<ProbeVerdict> {
  // 必须探完整清单，不能只看 loader.js。
  // v2.2.19 的故障就是 loader.js 还在，但 editor/main、worker、basic-languages 等已被裁掉，
  // 导致前端误判「本地 Monaco 可用」，真正初始化时才崩。
  //
  // 并行发起：7 次串行往返压成 1 轮并发往返，清单覆盖面一点没减。
  const verdicts = await Promise.all(LOCAL_MONACO_REQUIRED_FILES.map(probeMonacoAsset))

  // 明确的缺失优先于「没探明白」：只要有一个文件被服务端否认，本地副本就是残缺的。
  if (verdicts.includes('missing')) {
    return 'missing'
  }
  if (verdicts.includes('unknown')) {
    return 'unknown'
  }
  return 'available'
}

/**
 * 给 promise 加超时上限。
 * 注意：超时只影响我们自己的等待，不会取消底层加载；底层 promise 仍挂了 handler，不会变成未处理拒绝。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, buildError: () => Error) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(buildError()), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * `@monaco-editor/loader` 的 `init()` 是模块级一次性的，这一点决定了本模块能做什么、不能做什么：
 * - 内部 `wrapperPromise` 是模块作用域单例，只 settle 一次；
 * - `state.isInitialized` 第一次 `init()` 就置位，之后不再注入任何脚本，
 *   而库只导出了 `config` / `init` / `__getMonacoInstance`，没有任何重置入口；
 * - 所以第一次 `init()` 之后再 `loader.config()` 换路径完全无效，
 *   再 `init()` 拿到的只是同一个 promise 的新包装。
 *
 * 下面三个模块级变量就是如实记录这个约束：
 * - `loaderSource`：单例实际绑定到的来源，绑定后不可更改；
 * - `loaderPromise`：第一次 `init()` 的结果。之后一律复用，不再重复调 `init()` ——
 *   重复调用除了拿到同一个 promise 的新包装，还会因为库内部 `makeCancelable` 里
 *   `promise.then(onFulfilled)` 少挂一个 rejection handler，每次多产生一条未处理拒绝告警；
 * - `loaderFailure`：单例已经永久 reject 时的原始错误。一旦有值，页内怎么重试都是同一个结果，
 *   只有整页刷新才能重置模块状态 —— 这正是 `canRetryMonacoInPlace()` 存在的理由。
 */
let loaderSource: MonacoSource | null = null
let loaderPromise: Promise<Monaco> | null = null
let loaderFailure: unknown = null

function getMonacoVsPath(source: MonacoSource) {
  return source === 'cdn' ? MONACO_CDN_VS : `${import.meta.env.BASE_URL}${LOCAL_MONACO_VS}`
}

function initMonacoLoader(
  source: MonacoSource,
  timeoutMs: number,
  buildTimeoutError: () => Error
) {
  let pending = loaderPromise
  if (pending === null) {
    // 只有第一次 config 是有意义的，之后再配也不会改变单例已经绑定的路径
    loader.config({ paths: { vs: getMonacoVsPath(source) } })
    loaderSource = source
    pending = loader.init()
    // 永久失败必须挂在「底层单例」上而不是 withTimeout 的结果上：
    // 否则我们这边的超时会被误记成单例失败，把本来还有救的场景也判成必须刷新页面。
    // 注册顺序也有意义：这个 handler 早于 withTimeout 挂的 handler，
    // 保证调用方 catch 到错误时 loaderFailure 已经写好了。
    pending.catch((error: unknown) => {
      loaderFailure = error
    })
    loaderPromise = pending
  }

  return withTimeout(pending, timeoutMs, buildTimeoutError)
}

/**
 * 当前失败是否还能在页面内重试。
 *
 * loader 单例一旦 reject 就永久失败，页内重试拿到的必然是同一个错误；
 * 只有「我们这边等超时、底层其实还在加载」这种情况重试才真的有意义。
 * 组件据此决定给「重新加载编辑器」还是「刷新页面」，
 * 而不是留一个点了没有任何效果的按钮。
 */
export function canRetryMonacoInPlace(): boolean {
  return loaderFailure === null
}

const RELOAD_REQUIRED_HINT = '该失败无法在当前页面内重试，请刷新页面后再试。'

function loadLocalMonaco() {
  return initMonacoLoader('local', LOCAL_INIT_TIMEOUT_MS, () =>
    createMonacoError(
      '编辑器加载超时：面板内置的 Monaco 资源响应过慢或不完整，可以再等一次；' +
        '若反复超时，请更新或重新拉取面板镜像。'
    )
  )
}

function loadCdnMonaco() {
  return initMonacoLoader('cdn', CDN_INIT_TIMEOUT_MS, () =>
    createMonacoError(
      '编辑器加载失败：面板内置的 Monaco 资源不完整，且连接外部 CDN 超时。' +
        '请更新或重新拉取面板镜像；若面板处于内网环境，请确保镜像内 /monaco 资源完整。'
    )
  )
}

/**
 * 组装用户可见的失败原因。
 * 单例已永久失败时必须把「要刷新页面」说清楚，否则用户只会一直点重试。
 */
function describeLoadFailure(error: unknown, source: MonacoSource) {
  const detail =
    getMonacoLoadErrorMessage(error) ||
    (source === 'cdn'
      ? '编辑器加载失败：面板内置的 Monaco 资源不完整，且无法连接外部 CDN。'
      : '编辑器加载失败：面板内置的 Monaco 资源不完整或无法执行。')
  return loaderFailure !== null ? `${detail}${RELOAD_REQUIRED_HINT}` : detail
}

const EDITOR_BACKGROUND_VAR = '--dd-editor-bg-color'
const EDITOR_FOREGROUND_VAR = '--dd-editor-fg-color'

export interface MonacoThemeDescriptor {
  background: string
  foreground: string
  base: 'vs' | 'vs-dark'
  themeName: string
}

function readRootCssVar(name: string) {
  if (typeof window === 'undefined') {
    return ''
  }
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 从 `--dd-editor-*` 推导当前编辑器配色。
 * 变量由 applyPanelAppearance 写入：用户显式设过颜色时是用户值，留空时是跟随明暗主题的默认值。
 * 变量还没写入（极早期调用）时按当前面板明暗兜底，避免浅色模式闪一下深色编辑器。
 */
export function resolveMonacoTheme(): MonacoThemeDescriptor {
  const background =
    readRootCssVar(EDITOR_BACKGROUND_VAR) || getDefaultEditorBackgroundColor(isPanelDarkMode())
  const foreground = readRootCssVar(EDITOR_FOREGROUND_VAR) || getReadableTextColor(background)
  const dark = isDarkColor(background)

  return {
    background,
    foreground,
    base: dark ? 'vs-dark' : 'vs',
    themeName: dark ? 'dd-editor-dark' : 'dd-editor-light'
  }
}

// 只依赖 defineTheme：调用方持有的 monaco 实例既可能标成 `typeof import('monaco-editor')`，
// 也可能标成 loader 的 `Monaco`（editor.api 子集），用结构化最小类型避免两者互不赋值。
type MonacoThemeHost = {
  editor: Pick<Monaco['editor'], 'defineTheme'>
}

/**
 * 按当前配色注册（或就地刷新）Monaco 主题。
 * defineTheme 对同名主题是覆盖语义，且覆盖的正是当前生效主题时 Monaco 会自动重刷，
 * 调用方拿到 themeName 后再 setTheme 一次即可覆盖「明暗切换导致主题名也变了」的情况。
 */
export function defineMonacoTheme(monaco: MonacoThemeHost): MonacoThemeDescriptor {
  const theme = resolveMonacoTheme()
  const dark = theme.base === 'vs-dark'

  monaco.editor.defineTheme(theme.themeName, {
    base: theme.base,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': theme.background,
      'editor.foreground': theme.foreground,
      'editorLineNumber.foreground': dark ? '#6b7280' : '#94a3b8',
      'editorCursor.foreground': dark ? '#34d399' : '#2563eb',
      'editor.selectionBackground': dark ? '#134e4acc' : '#bfdbfe',
      'editor.inactiveSelectionBackground': dark ? '#1f2937aa' : '#dbeafe'
    }
  })

  return theme
}

async function resolveMonacoEditor(): Promise<MonacoLoadResult> {
  const startedAt = now()

  // loader 单例已经永久失败：直接给结论，连探测都不用再跑。
  // 底层 promise 已经 reject 且没有任何重置入口，再等一次只会拿到同一个错误。
  if (loaderFailure !== null) {
    throw createMonacoError(
      describeLoadFailure(loaderFailure, loaderSource ?? 'local'),
      loaderFailure
    )
  }

  // 单例已经绑定来源但还没 settle：说明上一次只是我们这边等超时了。
  // 此时探测结论已经改变不了实际加载路径，只能继续等同一个来源；
  // 再跑一遍探测然后声称「已回退 CDN」只会给出与事实不符的诊断。
  if (loaderSource !== null) {
    const source = loaderSource
    try {
      const monaco = source === 'cdn' ? await loadCdnMonaco() : await loadLocalMonaco()
      if (source === 'local') {
        writeProbeCache()
      }
      const elapsedMs = Math.round(now() - startedAt)
      reportLoadTiming(
        `[monaco] 续等上一次未完成的${source === 'cdn' ? ' CDN ' : '本地'}初始化并已完成，本次等待 ${elapsedMs} ms。`,
        elapsedMs
      )
      return { monaco, source, elapsedMs, probedFrom: 'reused-init' }
    } catch (error) {
      if (source === 'local') {
        clearProbeCache()
      }
      console.error('[monaco] 续等已有的 Monaco 初始化仍未成功。', error)
      throw createMonacoError(describeLoadFailure(error, source), error)
    }
  }

  const cached = readProbeCache()
  const probedFrom: ProbeOrigin = cached ? 'session-cache' : 'network'
  const verdict: ProbeVerdict = cached ? 'available' : await probeLocalMonaco()
  const probeElapsedMs = Math.round(now() - startedAt)

  if (verdict !== 'missing') {
    if (verdict === 'unknown') {
      // 只有网络抖动、没有明确缺失证据：继续走本地。
      // 同源都在抖的网络里改连 jsdelivr 只会让用户多等一轮再失败。
      console.warn('[monaco] 本地资源探测存在网络异常，未发现明确缺失，仍按本地资源加载。')
    }

    try {
      const monaco = await loadLocalMonaco()
      writeProbeCache()
      const elapsedMs = Math.round(now() - startedAt)
      reportLoadTiming(
        `[monaco] 本地资源加载完成，总耗时 ${elapsedMs} ms（其中探测 ${probeElapsedMs} ms，探测来源 ${probedFrom}）。`,
        elapsedMs
      )
      return { monaco, source: 'local', elapsedMs, probedFrom }
    } catch (error) {
      // 本地确实起不来：清掉会话缓存，避免下次继续按旧的「可用」结论直奔本地。
      clearProbeCache()
      console.error('[monaco] 本地 Monaco 初始化失败。', error)

      // 这里刻意不再尝试回退 CDN。
      // @monaco-editor/loader 的 init() 是一次性的：内部 wrapperPromise 是模块级单例，
      // 只会 settle 一次，且 isInitialized 置位后不再注入任何脚本。
      // 也就是说本地 init 已经 reject 之后，再 config 到 CDN 重新 init 拿到的还是同一个
      // 已 reject 的 promise —— 旧代码那条回退分支永远只是把同一个错误重新抛一遍，
      // 唯一的效果是把真实原因（本地资源残缺）盖成了含糊的「网络问题」。
      // 真正有效的 CDN 回退只有下面这条：探测阶段就判定本地缺失，让 init() 首次就指向 CDN。
      throw createMonacoError(describeLoadFailure(error, 'local'), error)
    }
  }

  clearProbeCache()
  console.warn(
    `[monaco] 本地 Monaco 资源不完整（探测 ${probeElapsedMs} ms），回退到 CDN：${MONACO_CDN_VS}。` +
      '若面板无外网访问权限，此次回退大概率会超时失败，请更新或重新拉取面板镜像。'
  )

  try {
    const monaco = await loadCdnMonaco()
    const elapsedMs = Math.round(now() - startedAt)
    reportLoadTiming(
      `[monaco] CDN 资源加载完成，总耗时 ${elapsedMs} ms（其中探测 ${probeElapsedMs} ms）。`,
      elapsedMs
    )
    return { monaco, source: 'cdn', elapsedMs, probedFrom }
  } catch (error) {
    // CDN 脚本加载失败（无外网时最常见）走的是 loader 里的 `script.onerror = state.reject`，
    // reject 出来的是原始 ErrorEvent，没有任何可读信息。
    // 这里必须补上具体原因，否则用户只会看到组件的泛化兜底文案，
    // 那条精心写过的「内置资源不完整且连不上 CDN」提示就只有超时路径能触发。
    console.error('[monaco] CDN Monaco 初始化失败。', error)
    throw createMonacoError(describeLoadFailure(error, 'cdn'), error)
  }
}

export async function loadMonacoEditor(): Promise<MonacoLoadResult> {
  if (!monacoPromise) {
    // 记忆化：并发调用（预加载 + 组件挂载 + 多个编辑器实例）共享同一次加载。
    // 失败时清空，让下一次调用可以重新走完整流程（重新探测 / 重新计时）。
    monacoPromise = resolveMonacoEditor().catch((error) => {
      monacoPromise = null
      throw error
    })
  }

  return monacoPromise
}
