import fs from 'node:fs'
import path from 'node:path'

const sourceDir = path.resolve(process.cwd(), 'node_modules/monaco-editor/min')
const targetDir = path.resolve(process.cwd(), 'dist/monaco')
const monacoVsDir = path.join(sourceDir, 'vs')
const monacoTargetVsDir = path.join(targetDir, 'vs')

const allowedNlsFiles = new Set([
  'nls.messages-loader.js',
  'nls.messages.js.js',
  'nls.messages.zh-cn.js.js',
  'nls.messages.zh-tw.js.js',
])

const allowedTopLevelVsFiles = new Set([
  '_commonjsHelpers-CT9FvmAN.js',
  'loader.js',
  'editor.api-CalNCsUg.js',
  'monaco.contribution-D2OdxNBt.js',
  'monaco.contribution-DO3azKX8.js',
  'monaco.contribution-EcChJV6a.js',
  'monaco.contribution-qLAYrEOP.js',
  'workers-DcJshg-q.js',
  'lspLanguageFeatures-kM9O9rjY.js',
  'javascript-PczUCGdz.js',
  'typescript-DfOrAzoV.js',
  'python-Cr0UkIbn.js',
  'shell-ClXCKCEW.js',
  'go-D_hbi-Jt.js',
  'jsonMode-DULH5oaX.js',
  'markdown-C_rD0bIw.js',
  'tsMode-CZz1Umrk.js',
  'cssMode-CjiAH6dQ.js',
  'htmlMode-Bz67EXwp.js',
  'css-CaeNmE3S.js',
  'html-Pa1xEWsY.js',
  'json.worker-DKiEKt88.js',
  'editor.worker-Be8ye1pW.js',
  'ts.worker-CMbG-7ft.js',
  'css.worker-HnVq6Ewq.js',
  'html.worker-B51mlPHg.js',
])

const allowedLanguageDirs = new Set([
  'css',
  'html',
  'json',
  'typescript',
])

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true })

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath)
      continue
    }

    fs.copyFileSync(sourcePath, targetPath)
  }
}

function pruneMonacoLocales() {
  if (!fs.existsSync(monacoTargetVsDir)) {
    return
  }

  for (const entry of fs.readdirSync(monacoTargetVsDir, { withFileTypes: true })) {
    const targetPath = path.join(monacoTargetVsDir, entry.name)

    if (entry.isDirectory()) {
      if (!allowedLanguageDirs.has(entry.name)) {
        fs.rmSync(targetPath, { recursive: true, force: true })
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if (entry.name.startsWith('nls.messages')) {
      if (!allowedNlsFiles.has(entry.name)) {
        fs.rmSync(targetPath, { force: true })
      }
      continue
    }

    if (allowedTopLevelVsFiles.has(entry.name)) {
      continue
    }

    fs.rmSync(targetPath, { force: true })
  }
}

copyDirectory(sourceDir, targetDir)
pruneMonacoLocales()
console.log('[copy-monaco-assets] copied monaco-editor/min -> dist/monaco and pruned extra Monaco locale bundles')
