import { installDemoAdapter } from './adapter'

/**
 * 产物门禁哨兵（`.github/workflows/checks.yml` 的两条断言就是靠它判定的）。
 *
 * 为什么必须是一个【字符串字面量】，而不能直接 grep `installDemo` 这类函数名：
 *   Vite 的应用构建开着 esbuild `minifyIdentifiers`，rollup 又对 `es` 格式默认开启
 *   `minifyInternalExports`，所以 `installDemo` 这个导出名在产物里会被压成 `a` 之类的单字母。
 *   拿函数名去 grep，发布版和 Demo 版都是 0 命中——门禁看着是绿的，实际上什么都没守。
 *   字符串字面量不会被改名，是唯一可靠的判据。
 *
 * 它必须被下面 installDemo() 里的活代码引用，否则会被 tree-shaking 掉，
 * Demo 版那条「哨兵必须存在」的断言就会误红。
 */
const DEMO_BUILD_MARKER = '__DAIDAI_DEMO_MOCK__'

/**
 * 在线演示 Demo 的统一安装入口。
 *
 * 由 web/src/main.ts 在 `import.meta.env.VITE_DEMO === '1'` 时动态 import 调用，
 * 必须在【app.use(router)】之前执行完——不是 app.mount() 之前。
 * vue-router 的 install() 内部同步就 push 了初始地址，app.use(router) 一执行
 * router.beforeEach 就跑起来，已登录状态下刷新页面时守卫会 await fetchUser()
 * 发出 GET /auth/user；那一发请求晚一步被接管，访客就会被打回登录页。
 *
 * ⚠️ 关于产物边界（发布版必须 0 字节 demo 代码）：
 *    - 只能被 main.ts 用动态 import() 加载，任何静态 import 都会把整个 demo 层
 *      拖进真实用户的产物；
 *    - 守卫条件必须是 import.meta.env.VITE_DEMO 这个编译期常量，不能改成运行期判断
 *      （比如读 location.hostname），那样 rollup 无法做死代码消除。
 *
 * ⚠️ 另一条容易走弯路的事实：全仓库【没有任何】 `new EventSource`，
 *    实时日志走的是 web/src/utils/sse.ts 里手写的 fetch + body.getReader()。
 *    想让假日志流跑起来，mock `window.EventSource` 是无效的，
 *    只能在 sse.ts 内部分叉——这部分属于后续阶段。
 */
export function installDemo() {
  installDemoAdapter()
  // 这行日志同时承担两个作用：一是让访客在控制台一眼看出「后端是假的」，
  // 二是把哨兵字符串钉进产物，供 CI 的两条产物断言使用（见上方常量说明）。
  console.info(`[demo] 演示环境 mock 层已安装 ${DEMO_BUILD_MARKER}`)
}
