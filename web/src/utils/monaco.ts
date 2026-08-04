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

type MonacoSource = 'local' | 'cdn'

export interface MonacoLoadResult {
  monaco: Monaco
  source: MonacoSource
}

let monacoPromise: Promise<MonacoLoadResult> | null = null

function getLocalMonacoWorkerUrl() {
  return `${import.meta.env.BASE_URL}${LOCAL_MONACO_VS}/loader.js`
}

function getLocalMonacoAssetUrl(relativePath: string) {
  return `${import.meta.env.BASE_URL}${LOCAL_MONACO_VS}/${relativePath}`
}

async function checkMonacoAssetExists(relativePath: string) {
  const assetUrl = getLocalMonacoAssetUrl(relativePath)

  try {
    const headResponse = await fetch(assetUrl, { method: 'HEAD', cache: 'no-store' })
    if (headResponse.ok) {
      return true
    }
    if (headResponse.status !== 405) {
      return false
    }
  } catch {
    return false
  }

  try {
    const getResponse = await fetch(assetUrl, { method: 'GET', cache: 'no-store' })
    getResponse.body?.cancel?.()
    return getResponse.ok
  } catch {
    return false
  }
}

async function canUseLocalMonaco() {
  // 不能只看 loader.js。
  // v2.2.19 的故障就是 loader.js 还在，但 editor/main、worker、basic-languages 等已被裁掉，
  // 导致前端误判“本地 Monaco 可用”，真正初始化时才崩。
  for (const relativePath of LOCAL_MONACO_REQUIRED_FILES) {
    const exists = await checkMonacoAssetExists(relativePath)
    if (!exists) {
      return false
    }
  }
  return true
}

async function loadLocalMonaco(): Promise<MonacoLoadResult> {
  loader.config({
    paths: {
      vs: `${import.meta.env.BASE_URL}${LOCAL_MONACO_VS}`
    }
  })

  const monaco = await loader.init()
  return { monaco, source: 'local' }
}

async function loadCdnMonaco(): Promise<MonacoLoadResult> {
  loader.config({
    paths: {
      vs: MONACO_CDN_VS
    }
  })

  const monaco = await loader.init()
  return { monaco, source: 'cdn' }
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

export async function loadMonacoEditor(): Promise<MonacoLoadResult> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      if (await canUseLocalMonaco()) {
        try {
          return await loadLocalMonaco()
        } catch (error) {
          console.warn('本地 Monaco 资源加载失败，已回退到 CDN。', error)
        }
      }

      return loadCdnMonaco()
    })().catch((error) => {
      monacoPromise = null
      throw error
    })
  }

  return monacoPromise
}
