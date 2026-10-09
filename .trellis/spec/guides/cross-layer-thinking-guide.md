# 跨层思考指南

> 这个项目很多问题都不是某一层单独写错，而是**层与层之间没对齐**。

---

## 这个项目最常见的跨层边界

- 前端页面 ↔ `web/src/api/*`
- 前端接口字段 ↔ 后端响应结构
- handler ↔ service
- service ↔ model / database
- 数据库字段 ↔ 前端展示 / 配置项 / 日志
- 任务执行链 ↔ 日志展示 ↔ 通知推送 ↔ 设置项

---

## 动手前先画一条线

至少在脑子里过一遍：

```text
入口 -> 参数 -> 业务处理 -> 数据存储/读取 -> 响应 -> 前端展示 -> 错误提示
```

然后问自己：

- 字段名在每层是不是一致？
- 某层做了格式转换吗？
- 空值、失败、超时、权限错误有没有覆盖？
- 这个改动会不会影响日志、通知、设置开关、任务状态？

---

## 这个项目里特别容易漏的联动

### 接口字段变更

要一起检查：

- `server/handler`
- `server/service`
- `server/model`
- `web/src/api`
- `web/src/views`
- 必要时 `stores` / `utils`

**给已有表加一个对外字段**（v3.3.6 环境变量 `important`，APP #16）：一个布尔字段就牵动下面这些地方，漏哪一处都不报错、构建照样全绿：

- [ ] **`ToDict` 永远下发，不加 omitempty**：独立发版的 APP 靠「有没有这个布尔键」做形状探测、不看版本号——键在且是布尔 = 新面板；
      键不在 = 老面板，整套相关界面隐藏、一个请求都不发。加了 omitempty，`false` 就不下发，新面板上没标记的变量会被 APP 当成老面板。
- [ ] **补列**：`EnsureColumns` 的补列写法与 GORM 建表写进 DDL 的逐字一致（契约 S3）；「先造缺列老表、再插 model 行」的测试要 `Omit` 新列
      （GORM 插入总会带上有默认值的列）。细则在 backend `database-guidelines.md`。
- [ ] **handler 的四个入口**：Create、Update（`*bool`，不传不动）、Export、Import。Import 的 merge 碰到旧文件怎么办要先想清楚：
      旧导出文件、老 APP 的导出再导入会把 `false` 原样带回来，`important` 因此定成「只升不降」。
- [ ] **备份**：`service/backup_types.go` 的结构体加字段，`backup_runtime.go` 的两个映射函数（`backupEnvVarFromModel` / `modelEnvVarFromBackup`）也要加——
      **手写副本，没有护栏**，漏了就是备份恢复一次值就没了；老备份、青龙备份没有这个键时恢复成什么，要写清楚。
- [ ] **MCP**：工具层的 `pickFields` 是白名单（`slimEnv`、`exportEnvs`），不加就不出现；导入工具的条目结构体同步；`docs/mcp.md` 工具表同步。
- [ ] **`web/src/views/api-docs/apiData.ts`**（手写副本，没有护栏）：响应示例、`responseFields`、新建 / 修改的 bodyParams、MCP 工具表。
- [ ] **演示站**：`web/src/demo/types.ts`、`adapter.ts`（读写与类型校验照服务端口径，包括「哪个路由不收这个键」）、`fixtures/business.ts` 的种子。
- [ ] **APP**：读取点与形状探测；APP 仓库 `.trellis/spec/frontend/panel-contract.md`「已验证的兼容底线」表登记字段与起始版本。
- [ ] **整体回写的入口**（网页编辑弹窗、APP 编辑）：用户没改这一项时请求体里不带这个键，否则弹窗打开时读到的旧值会冲掉别处刚改的值。

> 契约原文：backend `index.md` 的契约 E1；网页侧见 `frontend/component-guidelines.md`「环境变量的『重要』标记与删除确认」。

### 配置项变更

要一起检查：

- 后端配置读取
- 设置页展示
- 默认值处理
- 旧数据兼容
- 相关日志/任务行为

### Go ↔ shell 脚本的跨层改动

`Magisk/` 下的脚本与 Go 代码是**互相依赖的两层**，只改一边必然对不上。要一起检查：

- `Magisk/service.sh` 导出的环境变量 ↔ Go 里读它的地方（`DAIDAI_MAGISK_MODULE`、`DAIDAI_MAGISK_SHELL_VERSION`、`DAIDAI_ANDROID_RUNTIME_BIN_DIR`）
- Go 写出的文件名 / 哨兵 ↔ shell 里判断它的地方（例如升级窗口哨兵 `.updating`）
- 外壳版本号：改任何 `Magisk/*.sh` 或 rootfs 结构，`DAIDAI_MAGISK_SHELL_VERSION` 与 Go 里的 **`currentMagiskShellVersion`** 必须**一起加一**（后者的定义就是「本仓库 service.sh 当前 export 的值」，`magisk_assets_test.go` 静态断言两者相等）。
  **`requiredMagiskShellVersion` 不要跟着动** —— 它是「在线升级放行的最低外壳版本」，只有当新面板**无法**在旧外壳上运行时才提。提了就意味着所有还在跑旧外壳的用户必须先手动重刷一次模块 ZIP 才能继续在面板内一键升级。外壳只是多了一项增量能力时，正确做法是保持它不动、由前端按外壳版本 gating 并提示重刷。
- `server/handler/magisk_assets_test.go` 里的字符串断言（它只能防「整段被删掉」，防不住逻辑写错）

> shell 侧改动**必须真机验证**，静态断言给不了任何保证。详见后端质量规范的「Magisk 模块版的部署类型与在线升级」。

### 服务端 ↔ 独立发版的客户端（APP）

APP 在**另一个仓库**（`D:\GitHub\Dumb Panel\android-app`，Flutter，iOS/Android 共用一套代码），
独立发版。这条边界没有任何自动机制能发现脱节：服务端测试只测服务端，
APP 测试只测 APP，**两边各自 CI 全绿，功能却是坏的**。

已经出过一次的事故：面板用 **401 承载 2FA / 验证码挑战**（成功语义、4xx 载体），
APP 把全局 `validateStatus` 收紧成 `< 400` 后，这个信号在读到 body 之前就被抛成异常，
处理它的代码整段变成死代码。现象是「界面显示请输入两步验证码，但没有任何地方能输」。
详见后端质量规范的「场景：登录失败响应的机器可读 code 与 4xx 中间态」。

所以，改**任何**用非 2xx 承载中间态的接口时要问：

- 这个状态码在客户端那边会被当成失败直接抛掉吗？
- 客户端拿到的是**结构化字段**还是只剩一句错误文案？
- 服务端这次加的字段，APP 那边有没有对应的读取点？还是我只改了 Web？
- 有没有一条**服务端侧**的断言，能在客户端不改的情况下守住这个契约？

> 相关：`web/src/views/api-docs/apiData.ts` 是面板对外下发的契约文档。
> 它写错会直接把客户端带沟里——2FA 这次的成因之一，就是文档里把 401 一律
> 描述成「Token 过期，请重新获取」。改接口时它必须同步。

### 新增一个开放接口

v3.3.5 的 `GET /tasks/labels`（#157）一个接口就牵动下面五处，漏哪一处都不报错、构建照样全绿：

- [ ] **查询放 service**：`router → handler → service`，handler 只调用与响应；别照 `ListGroups` 那种在 handler 里直接查库的旧写法。
      契约按 7 段式写（`backend/index.md` 的「契约 L1」是现成例子）。
- [ ] **演示站要 mock**：`web/src/demo/adapter.ts` 注册路由、`db.ts` 照抄服务端口径（排序、去重、空值都要对上）。
      没注册的路径会落进兜底体 `{data: []}`，前端按「没有数据」静默处理——演示站上功能直接消失，没人会发现。
- [ ] **`web/src/views/api-docs/apiData.ts` 是手写副本，没有任何护栏**：接口条目与字段要手工补；MCP 那一节还写死了
      「共 N 个工具 / M 个查询类 / K 个写入类」与整张工具表，增删工具时一起改。
- [ ] **MCP 工具与 `docs/mcp.md` 同版补齐**：新工具进 `server/mcptools/server.go` 的 `readToolNames` / `writeToolNames`
      （测试按名单逐个核对，漏登记会红），`docs/mcp.md` 的权限范围表与工具表同步；接口返回裸数组时工具层要单独解码
      （规则原文在 `backend/index.md`，通用口径见后端质量规范「资源采样与 MCP 工具对齐」）。
- [ ] **独立发版的 APP、第三方脚本连老面板会拿到 404**：新接口只能锦上添花，客户端遇到 404、非数组、权限不足要**静默降级**
      （网页标签候选：当作「没有候选」，输入框照常可用），不能弹错或挡住主流程。

### 第三方库的内部时序 ↔ 应用启动顺序

「我把 X 推迟到 Y 之后了，所以 X 之前的事都安全了」——这个推理只有在**你确认过 Y 到底何时发生**时才成立。

已经出过一次的事故：在线演示 Demo 要在浏览器内用 axios adapter 顶替后端，
代码把 `app.mount()` 推迟到 mock 层装好之后，注释还写着「这样路由守卫首次导航就能被拦到」。
但 **vue-router 4 的初始导航是在 `app.use(router)` 里同步触发的，不是 `app.mount()`**
（`node_modules/vue-router/dist/vue-router.mjs` 的 `install()` 内直接 `push(routerHistory.location)`）。
于是守卫先跑、mock 后装，`GET /auth/user` 真打了网络，失败后守卫 `clearAuth()` 把访客踢回登录页。

更阴的是**它只在特定路径下复现**：首次访问因为没有 token 被 `!isLoggedIn` 提前短路，根本走不到那句请求；
只有「登录之后再刷新」才会暴露。一轮浏览器冒烟测试很容易正好避开它。

所以，凡是靠「装载顺序」保证正确性的改动，要问：

- 触发点到底在哪个函数里？**去 `node_modules` 里把那段源码读出来**，不要凭印象。
- 有没有哪条路径会**提前短路**，让问题在最常见的冒烟路径上不复现？
- 模块顶层的副作用（静态 `import` 求值时就执行的代码）根本排在任何 `bootstrap()` 之前——
  这类调用**改顺序是治不好的**，只能在它自己内部短路。

### 构建产物 ↔ CI 断言

给 CI 加一条 `grep` 门禁时，必须先确认**你 grep 的那个东西在产物里还存在**。

已经出过一次的事故：为守住「发布版产物必须 0 字节 demo 代码」，CI 里写了
`grep -rlE 'demo/fixtures|installDemo' dist/assets`。它在发布版和 Demo 版**都恒为 0 命中**：

- `installDemo` 是**标识符**，esbuild 压缩时会被改名成单字母；
- `demo/fixtures` 是**模块路径**，打包后压根不出现在产物里。

也就是说这条门禁从写下那天起就是空转的，而它"通过"了，看起来一切正常。

判据要选**压缩不会改动的东西**——字符串字面量、注释里的魔法串（注释会被删，别用）、文件数量、体积。
本项目最终用的是 `web/src/demo/index.ts` 里一个纯 ASCII 字符串字面量哨兵 `__DAIDAI_DEMO_MOCK__`。

**并且必须配一条反向断言**：发布版必须搜不到、Demo 版必须搜得到。
只写前一条的话，哪天哨兵被删被改名，两边又双双 0 命中，门禁静默失效且没有任何人会发现。

> 通用原则：**一条永远为真的断言等于没有断言。**
> 加门禁时顺手问一句「我怎么让它失败一次」，答不上来就说明它没有牙。

### 打包器的虚拟模块归属 ↔ 首屏依赖图 ↔ 懒加载

> v3.2.2 把 Monaco 作为可切换的第二引擎加回来时踩到的。

「某个重型依赖只在用户切过去时才下载」这件事，源码侧看起来只是一句 `await import()`，
但它成不成立取决于**打包器最终把哪些模块分到了哪个 chunk**——而这是源码里看不见的一层。

Vite 的模块预加载辅助函数是一个**虚拟模块**（`\0vite/preload-helper`），它不属于任何真实文件。
`rollupOptions.output.manualChunks` 如果不显式指派它的归属，Rollup 可以把它折进任意一个手动 chunk。
一旦折进了 `monaco` 那块，**入口就变成了静态 import monaco chunk**：
`dist/index.html` 里随之冒出 `<link rel="modulepreload" .../assets/monaco-*.js>` 和 monaco 的
`<link rel="stylesheet">`，懒加载当场失效，所有人白下约 1 MiB。

这件事的阴险之处正是本文档反复出现的那一类：

- **构建成功**，`vue-tsc` 全绿；
- **页面完全能用**，功能一个不少；
- **控制台没有任何输出**，Network 里也只是多了一条正常的 200。

也就是说它**没有任何运行期表现**，肉眼验收绝对发现不了，只能由产物门禁来守。

本项目的做法是两条一起上：

- `web/vite.config.ts` 把 `vite/preload-helper` / `vite/modulepreload-polyfill` **显式钉到 `app-core`**
  （它必然是首屏 chunk，`main.ts` 顶层就 import vue/router/pinia）。这条规则看着冗余，删掉就立刻回退。
- `.github/workflows/checks.yml` 里配一对**正反断言**：
  正向 `ls dist/assets/monaco-*.js` 保证 Monaco 真的被打包了，
  反向 `grep -qE '<link[^>]+(modulepreload|stylesheet)[^>]+/assets/monaco-' dist/index.html` 保证它没进首屏。
  没有正向那条的话，「Monaco 压根没被打包」时反向 grep 同样 0 命中——又是一条恒真的空转门禁，
  和上一节 Demo 哨兵那一对是同一个道理。

所以，新增「按需加载的重型依赖」时要问：

- 它在产物里**真的是独立 chunk** 吗？（不是「我写了 `await import()` 所以它一定是」）
- 入口 HTML 里**有没有**指向它的 `modulepreload` / `stylesheet`？
- 这两件事各有一条能失败的断言守着吗？
- 源码侧有没有唯一的导入边界？（本项目：`from 'monaco-editor/...'` 只允许出现在
  `web/src/utils/monacoEngine.ts`；别处引用类型时漏写 `import type` 的 `type` 关键字，
  就等于加了一条静态 import，效果与上面完全一样）

### 同一个输出目录被两种构建模式共用

**一旦两条构建往同一个目录写产物，任何「复用已存在产物」的脚本都必须能分辨它是哪一种。**

`web/dist` 现在有两个写入者，产物形状完全不同：

| 构建 | 产物特征 |
|---|---|
| `npm run build` | 无 mock 层、`robots=noindex`、资源为根相对路径 |
| `npm run build:demo` | 浏览器内 mock 顶替层、`robots=index, follow`、资源带 `/daidai-panel/` 前缀 |

而 `Magisk/build.sh` 的逻辑是「`web/dist` 已存在就跳过构建，直接 `cp` 进模块」。
于是「跑一次 `build:demo` → 打一个 Magisk 包」就会把整套 mock 层打进模块 ZIP，
装上去的表现是**面板能开、数据全是假的、一个错都不报**——比白屏难查得多。

这和上一条「构建产物 ↔ CI 断言」是同源教训，都是**看起来通过了，其实是错的东西**。
而且它有一个额外的阴险之处：**CI 够不着**。CI 每次都是全新 runner，
永远不存在「预先躺在那儿的 dist」，所以这类问题只在本地复现，
`checks.yml` 里那两条产物门禁再严也守不住这条路径。

所以，新增一条往已有输出目录写东西的构建时要问：

- 谁会**复用**这个目录而不是重建它？（本项目：`Magisk/build.sh` 复用；
  `Dockerfile*` 在 builder 阶段重建且 `.dockerignore` 已排除 `web/dist/`；
  `scripts/release-preflight.ps1` 无条件 `npm run build`——这三种要分别确认，不能一概而论）
- 判据选**压缩不会改动、且目标模式必然含有**的东西，判据要覆盖到「只差 base 前缀、
  没有 mock 层」这种**半污染**产物——只认 mock 哨兵是漏的。
- 命中后**直接失败并说清怎么办**，不要"贴心"地替用户重建：
  那会把一次误操作变成一次用户不知情的几分钟静默构建。
- 守卫本身要**能被单独跑一次**。`Magisk/build.sh` 的守卫原本排在 `command -v go` 后面，
  等于「没配 Go 就没法验证这道守卫」——所以它有一个 `--check-dist` 早退路径：
  `(cd web && npm run build:demo) && bash Magisk/build.sh --check-dist` 必须 exit 1。
  答不出这条命令，就又回到了上一条说的空转门禁。

> 另一半的解法是让两种构建**互不覆盖**（各写各的 outDir）。
> 本项目没这么做：历史原因是 `scripts/copy-monaco-assets.mjs` 把目标写死成 cwd 下的 `dist`
> （v3.2.0 换成 CodeMirror 6 后该脚本已删除），但 `clean-dist.mjs` / `copy-spa-fallback.mjs`
> 以及 `Magisk/build.sh`、`deploy-demo.yml` 仍然一律按 `web/dist` 取产物。
> 既然目录必须共用，那分辨的责任就落到每个复用方头上。
>
> v3.2.2 把 Monaco 作为可切换的第二引擎加回来时**没有**把那个脚本加回来，`web/scripts/` 至今只有
> `clean-dist.mjs` / `copy-spa-fallback.mjs` / `fetch-fonts.mjs` 三个：
> 新方案是裁剪 ESM + 动态 import，chunk 与 worker 由 Vite 直接产出，**没有任何构建后拷贝步骤**。
> 也就是说这段历史陈述仍然只是历史 —— 别把它读成「所以现在可以再加一个拷贝脚本」。

### 前端静态目录 ↔ Go 静态白名单 ↔ nginx

在 `web/public/` 下**新增一个子目录、或改一个根级文件的文件名**，是三层要一起动的改动。
漏改的表现是**静默失效，不是 404**。

`server/main.go` 的 `setupStaticFrontend()` 挂的是**白名单**
（子目录 `assets` / `fonts` / `sponsor-portal`，外加单文件路由 `favicon-512.webp`）。
v3.2.0 前名单里还有一个 `monaco`，随编辑器换成 CodeMirror 6（由 Vite 直接打包、不再有运行期资源目录）一并删掉。

> v3.2.2 把 Monaco 作为可切换的第二引擎加了回来，**但这条没有失效、后端一行都不用改**：
> 新方案是裁剪 ESM + 动态 import，chunk（`monaco-*.js`）、两个 worker、图标字体 `codicon-*.ttf`
> 全部由 Vite 产出在 `dist/assets/` 下，已被名单里的 `assets` 覆盖。
> 判断「要不要动白名单」的唯一标准是**产物有没有新增顶层目录**，不是「引入了哪个库」。
> （`docker/nginx.conf` 那边则确实要跟：缓存正则补了 `ttf`、`gzip_types` 补了 `font/ttf` ——
> 这正是下面那条「漏了不会坏，只是静默丢掉 `expires/immutable`」的现成例子。）

不在名单里的路径会掉进 `NoRoute` 的 SPA fallback，回一份 **200 + `text/html` 的 index.html**：

- 样式表 / 字体：浏览器按 MIME 拒绝使用，整套字体失效，Console 里只有一条不起眼的 MIME 警告；
- 图片：显示破图，而服务端访问日志里**全是 200**，按状态码排查会一无所获。

而 Docker 部署走 `docker/nginx.conf` 的 `try_files`，**完全不受这条约束**——这才是最坑的地方：
开发者本地用 Docker 验一遍全是好的，只有内嵌二进制部署（Magisk 模块 / Windows 单机版，无 nginx）
的用户会中招，且他们报不出这个 bug（界面只是"有点不对"）。

新增静态资源时要一起改：

- `server/main.go`：子目录加进白名单循环；根级单文件加 `engine.StaticFile`
- `docker/nginx.conf` 末尾的缓存正则：漏了不会坏，只是静默丢掉 `expires/immutable`
- 换文件名时，`web/index.html` 的引用与 `server/main.go` 的 `StaticFile` 路由是**两处硬编码**，
  必须同步（favicon 从 `.svg` 换到 `.webp` 时就是这两处）

> 这三处的注释里已经互相点名了对方的位置。看到其中一条时，默认还有另外两条。

### 构建输入是"跑一次脚本、提交进版本库"的产物

`web/public/fonts/*.woff2`（`scripts/fetch-fonts.mjs` 抓取）与
`web/src/demo/fixtures/*.json`（`server/cmd/gen-demo-fixtures` 生成）都属于这一类：
**生成器不在构建链上**：构建时不会重新生成它们，也不联网。
CI（`.github/workflows/checks.yml`）会跑 `go test ./...`，其中 `TestCommittedDemoFixturesMatchRegistry`
会把生成器的输出与仓库里的 fixture 逐字比对，注册表改了而 fixture 没重新生成时 CI 直接红——
改完注册表记得 `cd server; go run ./cmd/gen-demo-fixtures` 再提交。字体仍然没有这类对账。

于是有两条必须成立，否则干净检出后 CI 必挂或线上静默降级：

- 产物**真的进了版本库**——检查 `.gitignore` 没有 `*.woff2` 之类的规则；
  二进制另外在 `.gitattributes` 里显式标 `binary`，不要依赖 `* text=auto` 的内容嗅探
- 缺文件时**构建硬失败**，而不是默默产出残缺结果
  （字体走 `vite.config.ts` 的 `selfHostedFontsPlugin`；fixture 因为被 `import`，
  `vue-tsc -b` 直接报错）

反面做法是"构建期现下载"：那等于把刚从运行期去掉的第三方依赖原样搬到构建期，
每次发版都多一个 `fonts.gstatic.com` 单点。

### 任务与日志链路

要一起检查：

- 任务执行状态
- 日志落盘与展示
- 定时器/调度器
- 通知开关
- 前端状态刷新

### 仪表板与执行统计的口径

v3.3.6（#158）起「执行了几次」有两种口径，改统计、加统计入口之前先确认动的是哪一种：

| 口径 | 用在哪 | 删日志之后 |
|---|---|---|
| 现存 `task_logs` + 按天计数表 `task_log_daily_stats` | `GET /system/dashboard` 的今日（`today_logs` / `success_logs` / `failed_logs` / `aborted_logs`）、昨日（`yesterday_*`）与 `daily_stats`：网页仪表板的执行趋势、今日执行、成功率与较昨日，APP 首页趋势，MCP `get_dashboard` | 不变少（统一不减） |
| 只看现存 `task_logs` | 侧栏「今日失败」角标（`GET /system/badges` 的 `logs_failed_today`）、系统概况 `GET /system/stats`、`GET /tasks/:id/stats` | 跟着变少 |

- [ ] 清理日志之后，仪表板（加计数表）与日志列表、侧栏角标、系统概况（只看现存）对不上，比如仪表板今天的执行数大于日志列表里今天的条数，
      **这是对的**，别「修」成一致；新加统计入口先决定归哪一种，并写进接口说明（`apiData.ts`）。
- [ ] **改仪表板口径要同步演示站**：`web/src/demo/db.ts` 的数字全是现算的（文件头「设计要点」第 3 条），仪表板另加 `archivedDaily`，
      三处删日志的路由先 `archiveDemoLogs` 再删；`buildSystemBadges` / `buildSystemStats` 照旧只算现存。只改服务端不改这里，演示站会静默显示旧口径。
- [ ] 删 `task_logs` 的新入口一律经 `service.DeleteTaskLogs`（护栏会拦别的写法），细则在 backend `database-guidelines.md`。
- [ ] 用例：`TestDashboardTrendSurvivesEveryLogDeletionEntry` 逐个删除入口断言仪表板不变；
      `TestDashboardAddsArchivedCountsIncludingRangeOne` 同时断言只看现存的三个接口不受计数表影响。

---

## 跨层改动的最小检查清单

- [ ] 我改的字段或状态名是否全局搜过
- [ ] 前后端是否都同步了
- [ ] 错误返回结构是否和前端预期一致
- [ ] 旧数据、旧配置、老版本兼容是否考虑了
- [ ] 成功态、失败态、空态是否都能走通
- [ ] **独立发版的 APP** 有没有对应的读取点？还是我只改了 Web？
- [ ] `apiData.ts` 这份对外契约文档同步了吗？
- [ ] 新加的开关 / 字段，作用域是不是和它的名字一致？
      （`force_overwrite` 名字像管一切、实际只管 git 工作区文件，
      用户关了它以为能保住任务定时，其实两者正交——这类命名会直接制造 bug 报告）
- [ ] 这个「过滤 / 忽略」规则，读的一侧和写的一侧是不是**对称**的？
      （备份不打包 X + 还原也跳过 X ⇒ 恢复一次就把线上的 X 删了）
- [ ] 靠「装载 / 执行顺序」保证正确性时，触发点的源码我**真的读过**吗？
      有没有哪条路径会提前短路，让它在冒烟测试上不复现？
- [ ] 新加的 CI 断言，我说得出**怎么让它失败一次**吗？答不上来就是空转门禁
- [ ] 我这条构建往一个**已有输出目录**里写吗？谁会复用那个目录而不是重建它？
      它分得出产物是哪种模式吗？（CI 是全新 runner，这类问题只在本地复现）
- [ ] 往 `web/public/` 加了子目录 / 改了根级文件名？`server/main.go` 的静态白名单同步了吗？
      （漏了是 200 + index.html 的静默失效，且只在无 nginx 的部署形态下复现）
- [ ] 新增的"跑一次脚本产出、提交进库"的构建输入，`.gitignore` 放行了吗？缺文件时构建会硬失败吗？
- [ ] 新增的「遮蔽 / 脱敏」规则，**服务端和 Web 各有一份实现**吗？两份必须同口径
      （`server/handler/envsecret.go` ↔ `web/src/utils/envSecret.ts`）——只改 Web 的结果是
      「网页上打码、AI 或 APP 一问就是明文」
- [ ] 新增的 MCP 工具，能力边界与对应接口**完全一致**吗？工具不得绕开 handler 自己查库，
      也不得比接口多给一点（权限范围仍由 Open API 应用的 scope 决定）
- [ ] 新增开放接口时五处都过了吗：查询在 service、演示站 mock、`apiData.ts`（含写死的 MCP 工具数与工具表）、
      MCP 工具 + `docs/mcp.md`、客户端连老面板 404 静默降级？（清单见上文「新增一个开放接口」）
- [ ] 给已有表加对外字段：`ToDict` 永远下发（APP 靠键做形状探测）、导入导出、备份的两个映射函数、MCP、`apiData.ts`、演示站都同步了吗？
      （清单见上文「接口字段变更」里的「给已有表加一个对外字段」）
- [ ] 改了仪表板或统计接口的口径：演示站 `db.ts` 跟上了吗？改的是「加计数表」的那种，还是「只看现存」的那种？
      （见上文「仪表板与执行统计的口径」）
- [ ] 调用方需要区分「这个函数为什么返回 false」时，是自己**猜**（用别的状态近似推断）
      还是被调方**明说**？近似推断会在某个分支上静默失配
      （`reloadOnce` 返回 false 有离线 / 限次 / 存储不可用 / 未保存内容四种原因，
      路由曾用 `hasUnsavedWork() && onLine !== false` 近似，结果「有未保存内容 + 限次内」一条提示都没有）
- [ ] 「停止 / 取消」类能力，覆盖到那条链路的**每一段**了吗？
      （进程起来之前的准备阶段、两次重试之间的等待、进程刚被杀掉循环正要起下一轮——
      只杀进程的实现会被重试循环续上，表现为「点了停止又自己跑起来」）

---

## 最终原则

- **不要只看当前文件。**
- **不要默认别的层会“自动适配”。**
- **跨层改动必须带着全链路视角去做。**
