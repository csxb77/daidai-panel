import { loadPanelSettings, type PanelSettingsPayload, type PanelShapeStyle } from './panelSettings'

export interface PanelAppearanceSettings extends PanelSettingsPayload {}

/**
 * 圆角三档刻度表。
 *
 * 刻度集中在这一处，不要把数值散到分支里：调一档、加一档都只改这里。
 * square 三条全 0，与 styles/global.scss `:root` 里的默认值一致 ——
 * 这样「没写过内联变量」和「显式写成直角」看到的是同一个结果。
 *
 * 对应关系（详见 spec/frontend/design-system.md）：
 * - control：按钮、输入框、tag、分段项、图标按钮、浮层菜单项
 * - surface：卡片、表格容器、弹窗、日志面板等容器类表面
 * - pill：状态 chip、计数角标、进度条这类天然胶囊
 */
const PANEL_SHAPE_RADIUS: Record<PanelShapeStyle, { control: string; surface: string; pill: string }> = {
  square: { control: '0', surface: '0', pill: '0' },
  rounded: { control: '6px', surface: '10px', pill: '999px' },
}

const DEFAULT_PANEL_SHAPE: PanelShapeStyle = 'square'

/**
 * 圆角风格的本机缓存键（命名沿用仓库既有的 `dd:<模块>:<名字>`）。
 *
 * 存在的唯一理由是首屏防闪形：panel-settings 是异步 fetch，首帧一定先按 :root 的
 * 直角画一遍，圆角用户会看到「先方后圆」的形状跳变，比闪色刺眼得多。
 * 这里只是一份加速缓存，服务端值一回来就以服务端为准。
 */
const PANEL_SHAPE_STORAGE_KEY = 'dd:appearance:shape'

const DEFAULT_LOG_BACKGROUND_COLOR_LIGHT = '#f8fafc'
const DEFAULT_LOG_BACKGROUND_COLOR_DARK = '#0f172a'
// 编辑器底色的「留空默认值」跟随面板明暗主题：浅色模式白底深字，深色模式深底浅字。
// 注意：只有 editor_background_color 留空时才走这里；用户在系统设置里显式设过颜色一律以用户值为准。
const DEFAULT_EDITOR_BACKGROUND_COLOR_LIGHT = '#ffffff'
const DEFAULT_EDITOR_BACKGROUND_COLOR_DARK = '#111827'
const DEFAULT_EDITOR_FOREGROUND_COLOR = '#e5e7eb'
const DEFAULT_LOG_TEXT_COLOR_LIGHT = '#111827'
const DEFAULT_LOG_TEXT_COLOR_DARK = '#e2e8f0'

/**
 * 面板外观（编辑器/日志底色等）变更事件。
 * 代码编辑器的主题是在挂载时一次性构建的（CodeMirror 的 extensions 只在建 state 时读一次），
 * 切主题或改配置后必须靠这个事件重新构建主题并通过 Compartment 换上去，
 * 否则已挂载的编辑器不会跟着变色。
 */
export const PANEL_APPEARANCE_CHANGE_EVENT = 'dd:panel-appearance-change'

function toCSSImageValue(image?: string) {
  const trimmed = image?.trim() || ''
  if (!trimmed) {
    return 'none'
  }

  return `url("${trimmed.replace(/"/g, '\\"')}")`
}

function parseColor(color?: string) {
  const text = color?.trim() || ''
  if (!text) return null

  if (text.startsWith('#')) {
    const hex = text.slice(1)
    if (hex.length === 3) {
      const r = Number.parseInt(hex.charAt(0) + hex.charAt(0), 16)
      const g = Number.parseInt(hex.charAt(1) + hex.charAt(1), 16)
      const b = Number.parseInt(hex.charAt(2) + hex.charAt(2), 16)
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b }
    }
    if (hex.length === 6 || hex.length === 8) {
      const offset = hex.length === 8 ? 2 : 0
      const r = Number.parseInt(hex.slice(offset, offset + 2), 16)
      const g = Number.parseInt(hex.slice(offset + 2, offset + 4), 16)
      const b = Number.parseInt(hex.slice(offset + 4, offset + 6), 16)
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b }
    }
  }

  const match = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[0-9.]+\s*)?\)$/i)
  if (!match) {
    return null
  }

  const r = Number.parseInt(match[1] ?? '', 10)
  const g = Number.parseInt(match[2] ?? '', 10)
  const b = Number.parseInt(match[3] ?? '', 10)
  return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { r, g, b }
}

export function isDarkColor(background?: string) {
  const rgb = parseColor(background)
  if (!rgb) {
    // 解析不出来时按深色处理，与历史行为一致（前景色回退到浅字）
    return true
  }

  const toLinear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b)
  return luminance < 0.45
}

export function getReadableTextColor(background?: string) {
  return isDarkColor(background) ? DEFAULT_EDITOR_FOREGROUND_COLOR : DEFAULT_LOG_TEXT_COLOR_LIGHT
}

export function isPanelDarkMode() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

export function getDefaultEditorBackgroundColor(isDark: boolean) {
  return isDark ? DEFAULT_EDITOR_BACKGROUND_COLOR_DARK : DEFAULT_EDITOR_BACKGROUND_COLOR_LIGHT
}

function getDefaultLogBackgroundColor(isDark: boolean) {
  return isDark ? DEFAULT_LOG_BACKGROUND_COLOR_DARK : DEFAULT_LOG_BACKGROUND_COLOR_LIGHT
}

function getDefaultLogTextColor(isDark: boolean) {
  return isDark ? DEFAULT_LOG_TEXT_COLOR_DARK : DEFAULT_LOG_TEXT_COLOR_LIGHT
}

// 服务端下发的值不可信（历史脏值、将来新增枚举值、大小写/空格），认不出来一律返回 null
// 交给调用方决定回退策略，而不是在这里直接兜成 square —— 见 lastAppliedShape 的说明。
function normalizePanelShape(raw?: string | null): PanelShapeStyle | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'rounded') return 'rounded'
  if (value === 'square') return 'square'
  return null
}

function readCachedPanelShape(): PanelShapeStyle {
  // 隐私模式 / 禁用站点存储时读 localStorage 会直接抛错，这里在模块初始化阶段执行，
  // 不兜住会让整个 main.ts 挂掉、页面全白
  try {
    if (typeof window === 'undefined') return DEFAULT_PANEL_SHAPE
    return normalizePanelShape(window.localStorage.getItem(PANEL_SHAPE_STORAGE_KEY)) ?? DEFAULT_PANEL_SHAPE
  } catch {
    return DEFAULT_PANEL_SHAPE
  }
}

// 最近一次显式取到的圆角风格。刻意与 lastAppliedSettings 分开记：
// 设置页保存/加载时会调 applyPanelAppearance(configForm.value)，而 panel_shape_style
// 走的是「其他配置」兜底区、压根不在 configForm 里（见 useSettingsConfig.ts 的差集机制），
// 跟着整份设置一起被覆盖的话，进一次设置页就会被拍回直角。
// ⇒ 只有本次真的带了合法值才更新，否则沿用上一次的结果。
let lastAppliedShape: PanelShapeStyle = readCachedPanelShape()

/**
 * 把圆角刻度写进 documentElement 的三条 `--dd-radius-*`。
 *
 * 传了合法值就以它为准并记进本机缓存；不传（或值不认识）就沿用上一次的结果。
 * 三个调用方：
 * 1. main.ts 在 createApp 之前不传参同步调一次（用 localStorage 缓存防首屏闪形）；
 * 2. applyPanelAppearance() 拿服务端下发的 panel_shape_style 调；
 * 3. 设置页「其他配置」兜底区保存成功后，由 useSettingsConfig.ts 的 handleSaveExtraConfigs()
 *    直接把草稿值传进来调本函数（panel_shape_style 不在 configForm 里，
 *    那条保存路径不会重跑 applyPanelAppearance，所以要单独补这一次）。切换后即时生效，无需刷新页面。
 *
 * square 这一档是显式写 `0` 而不是 removeProperty()：同一次会话里可能先写过 rounded
 * （改配置、切主题都会重跑），显式写死才是幂等的；靠移除内联覆盖去露出 :root 的 0，
 * 还要额外保证 :root 那三条永远存在，反而更脆。
 */
export function applyPanelShapeStyle(raw?: string | null) {
  const next = normalizePanelShape(raw)
  if (next) {
    lastAppliedShape = next
    try {
      window.localStorage.setItem(PANEL_SHAPE_STORAGE_KEY, next)
    } catch {
      // 隐私模式 / 禁用站点存储：写不进去只是下次首屏会闪一下形状，不影响本次生效
    }
  }

  if (typeof document === 'undefined') return
  const radius = PANEL_SHAPE_RADIUS[lastAppliedShape]
  const root = document.documentElement
  root.style.setProperty('--dd-radius-control', radius.control)
  root.style.setProperty('--dd-radius-surface', radius.surface)
  root.style.setProperty('--dd-radius-pill', radius.pill)
}

// 最近一次显式传入的外观设置。
// 主题切换只需要重新推导「留空默认值」，不应该把用户已保存的自定义颜色一起抹掉，
// 所以 applyPanelAppearance() 不传参时复用这里的缓存。
let lastAppliedSettings: PanelAppearanceSettings | null = null

export function applyPanelAppearance(settings?: PanelAppearanceSettings | null) {
  if (typeof settings !== 'undefined') {
    lastAppliedSettings = settings
  }

  const effective = lastAppliedSettings
  const root = document.documentElement
  const isDark = root.classList.contains('dark')
  const editorBackground =
    effective?.editor_background_color?.trim() || getDefaultEditorBackgroundColor(isDark)
  const logBackground = effective?.log_background_color?.trim() || getDefaultLogBackgroundColor(isDark)
  root.style.setProperty('--dd-editor-bg-color', editorBackground)
  root.style.setProperty('--dd-editor-fg-color', getReadableTextColor(editorBackground))
  root.style.setProperty('--dd-log-bg-color', logBackground)
  root.style.setProperty('--dd-log-text-color', getReadableTextColor(logBackground) || getDefaultLogTextColor(isDark))
  root.style.setProperty('--dd-log-theme-mode', isDark ? 'dark' : 'light')
  root.style.setProperty('--dd-log-bg-image', toCSSImageValue(effective?.log_background_image))

  // 圆角刻度：本次带了合法值就更新，没带就沿用上一次的（理由见 lastAppliedShape）
  applyPanelShapeStyle(effective?.panel_shape_style)

  // CSS 变量已经写完，通知已挂载的代码编辑器实例重新构建并换上主题
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PANEL_APPEARANCE_CHANGE_EVENT))
  }
}

export async function fetchAndApplyPanelAppearance() {
  try {
    const settings = await loadPanelSettings()
    applyPanelAppearance(settings || null)
  } catch {
    // ignore startup appearance load failures
  }
}

/**
 * 界面动效偏好（个人设置页「界面动效」）。
 *
 * - system（默认）：<html> 上什么都不挂，跟随系统的 prefers-reduced-motion；
 * - always：挂 dd-motion-force，系统开着「减少动态效果」也照常播放动画；
 * - reduce：挂 dd-motion-off，不看系统，一律把动效压到几乎不可见。
 * 两个 class 的实际作用写在 styles/global.scss 文件末尾「减少动效」那一段。
 *
 * 刻意做成本机偏好（localStorage），不进服务端的 system_configs：
 * 它回答的是「这台设备前的人想不想看动画」，和 panel_shape_style 那种「整个面板长什么样」不是一类；
 * 放进系统配置还会让 APP 的 schema 驱动设置页多出一个点了没用的开关。
 * 默认必须是 system：「始终开启」会覆盖系统的无障碍偏好，只能由用户自己选。
 */
export type MotionPreference = 'system' | 'always' | 'reduce'

// 命名沿用 dd:appearance:* 这一组（与圆角缓存键 dd:appearance:shape 同级）
const MOTION_PREFERENCE_STORAGE_KEY = 'dd:appearance:motion'
const MOTION_FORCE_CLASS = 'dd-motion-force'
const MOTION_OFF_CLASS = 'dd-motion-off'

function normalizeMotionPreference(raw?: string | null): MotionPreference | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'system' || value === 'always' || value === 'reduce') return value
  return null
}

export function readMotionPreference(): MotionPreference {
  // 隐私模式 / 禁用站点存储时读 localStorage 会直接抛错；这里在 createApp 之前执行，不兜住会白屏
  try {
    if (typeof window === 'undefined') return 'system'
    return normalizeMotionPreference(window.localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)) ?? 'system'
  } catch {
    return 'system'
  }
}

/**
 * 把动效偏好挂到 <html> 上，返回最终生效的档位。
 *
 * 传了合法值：以它为准并写进本机缓存（个人设置页切换时走这条，即时生效、无需刷新）；
 * 不传或值不认识：按本机缓存重放一遍（main.ts 在 createApp 之前走这条）。
 *
 * ⚠️ main.ts 里这一次必须在首帧之前同步执行：挂晚了，「始终开启」的用户首屏动画会先被系统设置
 *    压成 1ms，「减少动效」的用户则会先看到一遍完整动画 —— 与 applyPanelShapeStyle 防闪形同理。
 */
export function applyMotionPreference(raw?: string | null): MotionPreference {
  const explicit = normalizeMotionPreference(raw)
  const next = explicit ?? readMotionPreference()
  if (explicit) {
    try {
      window.localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, explicit)
    } catch {
      // 写不进去（隐私模式）只是下次打开要重新选，不影响本次生效
    }
  }

  if (typeof document === 'undefined') return next
  const classList = document.documentElement.classList
  classList.toggle(MOTION_FORCE_CLASS, next === 'always')
  classList.toggle(MOTION_OFF_CLASS, next === 'reduce')
  return next
}
