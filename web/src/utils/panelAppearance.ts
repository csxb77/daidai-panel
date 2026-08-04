import { loadPanelSettings, type PanelSettingsPayload } from './panelSettings'

export interface PanelAppearanceSettings extends PanelSettingsPayload {}

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
 * Monaco 主题是在挂载时一次性 defineTheme 的，切主题或改配置后必须靠这个事件重新定义并 setTheme，
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

  // CSS 变量已经写完，通知已挂载的 Monaco 实例重新 defineTheme + setTheme
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
