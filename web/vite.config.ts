import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin, ResolvedConfig } from 'vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

const localMonacoSourceDir = path.resolve(process.cwd(), 'node_modules/monaco-editor/min')

function normalizeBase(base: string) {
  return base === '/' ? '' : base.replace(/\/$/, '')
}

function getContentType(filePath: string) {
  switch (path.extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'application/javascript; charset=utf-8'
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.ttf':
      return 'font/ttf'
    default:
      return 'application/octet-stream'
  }
}

function localMonacoAssetsPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig

  return {
    name: 'local-monaco-assets',
    apply: 'serve',
    configResolved(config) {
      resolvedConfig = config
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url?.split('?')[0] || ''
        const prefix = `${normalizeBase(resolvedConfig.base)}/monaco/`
        if (!requestUrl.startsWith(prefix)) {
          next()
          return
        }

        const relativePath = requestUrl.slice(prefix.length)
        const filePath = path.resolve(localMonacoSourceDir, relativePath)
        if (!filePath.startsWith(localMonacoSourceDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          next()
          return
        }

        res.setHeader('Content-Type', getContentType(filePath))
        fs.createReadStream(filePath).pipe(res)
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  // 只有 `vite build --mode demo`（npm run build:demo）会加载 web/.env.demo，
  // 从而拿到 VITE_DEMO=1；发布版构建走默认的 production 模式，读不到这个变量。
  const isDemoBuild = loadEnv(mode, process.cwd(), 'VITE_').VITE_DEMO === '1'

  return {
    define: {
      // 硬约束：发布版产物必须 0 字节 demo 代码。
      //
      // 这条 define 的作用是把 `import.meta.env.VITE_DEMO` 变成【确定的字符串字面量】。
      // 不加它的话，未定义该变量时 Vite 只会把整个 `import.meta.env` 替换成对象字面量，
      // 表达式退化成 `{...}.VITE_DEMO === '1'`——这种形式压缩器不一定会常量折叠，
      // 一旦折叠不掉，main.ts 里的 `import('./demo')` 就会被当成活代码，
      // demo 层连同 fixture 会被打进真实用户拿到的产物里（最坏情况：真实面板的请求被 mock 顶替）。
      //
      // 折叠成 '' 之后，`'' === '1'` 恒假，rollup 会把整段分支与对应 chunk 一起剔除。
      'import.meta.env.VITE_DEMO': JSON.stringify(isDemoBuild ? '1' : '')
    },
    plugins: [
      vue(),
      localMonacoAssetsPlugin(),
      Components({
        dts: false,
        resolvers: [
          ElementPlusResolver({
            importStyle: 'css'
          })
        ]
      })
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    build: {
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules/@monaco-editor/loader')) return 'monaco-loader'
            if (id.includes('node_modules/@monaco-editor')) return 'monaco-loader'
            if (id.includes('node_modules/echarts')) return 'echarts'
            if (id.includes('node_modules/zrender')) return 'zrender'
            if (id.includes('node_modules/qrcode')) return 'qrcode'
            if (id.includes('node_modules/sortablejs')) return 'sortablejs'
            if (id.includes('node_modules/element-plus')) return undefined
            if (
              id.includes('node_modules/vue') ||
              id.includes('node_modules/@vue') ||
              id.includes('vue-router') ||
              id.includes('pinia') ||
              id.includes('axios')
            ) return 'app-core'
            if (id.includes('node_modules')) return 'vendor'
            return undefined
          }
        }
      }
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:5701',
          changeOrigin: true
        }
      }
    }
  }
})
