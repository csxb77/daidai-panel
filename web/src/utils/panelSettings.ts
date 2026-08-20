export interface PanelSettingsPayload {
  panel_title?: string
  panel_icon?: string
  editor_background_color?: string
  log_background_color?: string
  log_background_image?: string
}

let cachedPanelSettings: PanelSettingsPayload | null = null
let panelSettingsPromise: Promise<PanelSettingsPayload | null> | null = null

export function getCachedPanelSettings() {
  return cachedPanelSettings
}

export function getCachedPanelTitle() {
  return cachedPanelSettings?.panel_title?.trim() || '呆呆面板'
}

export async function loadPanelSettings(options?: { force?: boolean }) {
  if (!options?.force && panelSettingsPromise) {
    return panelSettingsPromise
  }

  const requestPromise = (async () => {
    // 在线演示 Demo 分叉：静态站没有后端，下面那发裸 fetch 必然 404。
    //
    // 这一处是整个应用打出去的【第一发请求】——router/index.ts 的模块顶层就有一句
    // `void loadPanelSettings()`，它在 main.ts 的 bootstrap() 函数体之前就求值了，
    // 比 installDemo() 还早。也就是说 demo 的 axios adapter 无论如何都拦不到它
    // （何况它压根不走 axios），只能在这里短路。
    //
    // 守卫形状不能动：`import.meta.env.VITE_DEMO` 是编译期常量，发布版里是 ''，
    // 整个 if 连同 '@/demo/shortcuts' 那个异步 chunk 会被 rollup 剔除。
    // 不要改成运行期判断，也不要静态 import demo 目录。
    if (import.meta.env.VITE_DEMO === '1') {
      const { demoPanelSettings } = await import('@/demo/shortcuts')
      cachedPanelSettings = demoPanelSettings()
      return cachedPanelSettings
    }

    try {
      const response = await fetch('/api/system/panel-settings', { cache: 'no-store' })
      if (!response.ok) {
        return cachedPanelSettings
      }

      const payload = await response.json() as { data?: PanelSettingsPayload }
      cachedPanelSettings = payload.data || null
      return cachedPanelSettings
    } catch {
      return cachedPanelSettings
    }
  })()

  panelSettingsPromise = requestPromise
  const result = await requestPromise
  if (!cachedPanelSettings) {
    panelSettingsPromise = null
  }
  return result
}
