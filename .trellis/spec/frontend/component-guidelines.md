# 组件规范

> 适用于 `views/*/*.vue`、`components/*.vue`、`layouts/*.vue`。

---

## 总原则

- 优先让组件**一眼能看懂**。
- 组件拆分以“职责边界明确”为前提，不以“文件越小越好”为目标。
- 如果一段逻辑只服务于当前组件，并不会复用，优先留在当前组件内。
- 复杂交互、边界分支、兼容逻辑建议补中文注释。

---

## 组件拆分边界

### 适合拆出去的情况

- 某块 UI 在多个页面/多个弹窗里复用。
- 当前页面太长，某个局部区域已经有独立职责。
- 某块区域本身就有清晰输入输出，比如表单、详情面板、日志查看器。

### 不适合拆出去的情况

- 只是为了“每个文件行数少一点”。
- 逻辑高度依赖父组件内部状态，拆出去反而传一堆 props 和 events。
- 只会出现一次、且本身并不复杂。

---

## 文件内部结构建议

Vue 单文件组件通常按下面顺序组织：

1. `template`
2. `script setup`
3. `style`

在 `script setup` 内部建议顺序：

1. import
2. 类型定义
3. props / emits
4. 响应式状态
5. 计算属性 / 侦听
6. 事件函数 / 业务函数
7. 生命周期

---

## props 和 emits

- props 要尽量语义清楚，别用模糊命名。
- 如果组件只是局部页面组件，也不要为了抽象强行设计很复杂的 props API。
- 对外事件名尽量直接体现动作，例如“保存”“关闭”“刷新”。
- 对业务对象较复杂的场景，优先传明确结构对象，不要传大量分散字段。

---

## 样式方式

- 当前项目以 `scss/css` 为主，样式应尽量贴近组件或页面目录。
- 页面专属样式优先就近放置。
- 多个设置卡片共用样式时，可以像现有项目一样提取共享 scss 文件，但前提是确实存在复用。
- 不要为了统一视觉把页面样式过度抽象成很难追踪的公共类名。

---

## 交互与可读性

- 表单、弹窗、抽屉、表格操作应保持用户路径清晰。
- 错误提示、确认弹窗、空状态文案要直接明确，不要写得太“技术化”。
- 当交互状态较多时，建议用清晰的状态变量名，不要混成一个难懂的大对象。

---

## 常见错误

- 一个页面拆出过多薄组件，导致阅读要来回跳文件。
- 把页面局部逻辑硬做成“通用组件”，结果 props/emits 变得复杂。
- 没有中文注释，导致状态切换或边界逻辑难理解。
- 同一类弹窗、卡片、表单在不同地方写出完全不同的交互风格。

---

## 移动端全屏弹窗：为什么 media 块里要单独写一遍 `.is-fullscreen`

> 记录日期 2026-08-08（基线 v3.0.1 发现），**v3.0.2 已修复**。
> 保留本节是为了防止有人「顺手清理冗余」把修复删掉。

**曾经的现象**：`≤768px` 下所有全屏弹窗高度是满的，左右各短 4vw，露出两条遮罩边。

**根因是 CSS 层叠，不是写错**：

```scss
// Element Plus 自己的实现（node_modules/element-plus/theme-chalk/el-dialog.css）
.el-dialog               { width: var(--el-dialog-width, 50%); }   // 无 !important
.el-dialog.is-fullscreen { --el-dialog-width: 100%; height: 100%; }  // 也无 !important，且不写 width

// global.scss，在 @media screen and (max-width: 768px) 里
.el-dialog {
  --el-dialog-width: 92vw !important;
  width: 92vw !important;      // ← 带 !important，直接盖掉上面那条 width
}
```

EP 是**通过改变量**实现全屏的，而这里是**直接写 width 且带 `!important`**。
带 `!important` 的声明无条件胜过不带的（与特异性、源码顺序都无关），
所以 `.is-fullscreen` 那条 `--el-dialog-width: 100%` 根本没机会参与计算。

**修法**：在**同一个 media 块内**补 `&.is-fullscreen`，`--el-dialog-width` 与 `width` **两条都要写**。
只补 `width` 渲染结果就已经对了，但变量会停在 92vw，留下「变量值与实际宽度不一致」的状态。

不能改成 `.el-dialog:not(.is-fullscreen)` 来规避：那样非全屏弹窗会回落到组件自己的
`width` prop（`600px` / `1100px` 这类写死值），在窄屏上溢出——92vw 这条兜底正是防它的。
也不能指望改 `global.scss:341-350` 那个非 media 的 `&.is-fullscreen` 块：它在 media 生效时
压不过 `92vw !important`；给它加 `!important` 又会让桌面端也被强制 100%。

`margin` / `max-height` / `border-radius` **不需要跟着改**，三者已各自就位
（`:348` 把 `--el-dialog-margin-top` 置 0 使 margin 解析成 `0 auto`；`:347` 的 `max-height: 100dvh`；
`:278` 全站圆角归零）。往 media 块里再塞 `margin: 0 !important` 只会掩盖 `:348` 的作用。

**影响面**：`:fullscreen=` 绑定 **46 处 / 26 个文件**，另有 **2 处静态 `fullscreen`**
（`ScriptExecutionDialogs.vue:47` 与 `:110`，桌面端也全屏），合计 **48 个全屏弹窗 / 27 个文件**。
改 `global.scss` 一处即可覆盖全部，**调用点一个都不用动**。

**⚠️ 下面两处曾被误记为「局部绕过宽度」，实际都不是**（2026-08-10 逐行核实推翻）：

- `ScriptExecutionDialogs.vue:316-322`——注释里的「用双 class 提高特异性」讲的是
  **覆盖全局进场动画**，块体只有 `animation` 与 `transform-origin`，**没有 width**。
  别去「清理」它：`:324-328` 的注释解释了为何刻意不加 `both/forwards`——残留 transform
  会成为编辑器 `position:fixed` 浮层（补全 / 搜索面板）的包含块，导致弹层错位。
  （v3.2.0 前这里写的是 Monaco 的补全浮层；换成 CodeMirror 6 后这条约束**依然成立**，
  只是浮层换成了 `.cm-tooltip` / `.cm-panels`。）
- `LogViewer.vue:1088-1094`——确实重声明了 `&.is-fullscreen`，但**五条全部没有 `!important`**，
  所以其中的 `width: 100%` 一直是死代码，压不过 global 那条。它真正生效的是
  `height` / `max-height` / `border-radius`（用来压住本组件自己的桌面端尺寸）。

全库 `is-fullscreen` 仅 5 处命中，已确认**没有第三、第四处绕过点**，不必再全站找一遍。

**为什么必须走「特异性 + !important」而不是靠后写覆盖**：`vite.config.ts` 用的是
`ElementPlusResolver({ importStyle: 'css' })`，EP 组件样式随各 `.vue` 按需导入注入，
相对 `global.scss` 的位置不确定，dev 与 build 还可能不同。任何依赖源码顺序的写法都不可靠。

## Scenario: 日志查看器中的 `\r` 单行覆盖刷新

### 1. Scope / Trigger
- Trigger: 修改任务日志查看器、执行日志详情、日志文件预览这类终端风格日志组件时必须看本节。
- 原因: 任务脚本常输出进度条，裸 `\r` 不是“换行”，而是“把光标移回当前行开头并覆盖原内容”。如果日志组件在每个流式分片到达时都强行追加新行，进度条就会刷屏。

### 2. Signatures
- 任务实时日志组件: `web/src/views/tasks/components/LogViewer.vue`
- 执行日志详情页: `web/src/views/logs/index.vue`
- 日志文件预览: `web/src/views/tasks/components/LogFileBrowser.vue`

### 3. Contracts
- 渲染规则必须区分三类边界:
  - `\n`: 真正落一新行
  - `\r\n`: 真正落一新行
  - 裸 `\r`: 清空当前行并等待后续字符覆盖
- 流式日志组件不能在“每个数据分片结束”时默认把当前 tail 强制 push 成一整行。
- 只有确认遇到真实换行，或者该分片本身没有覆盖语义时，才允许落行为历史行。

### 4. Validation & Error Matrix
- 纯文本日志 -> 展示行为与原来一致
- `下载中 10%\r下载中 20%\r下载中 30%\n` -> 最终只保留一条当前进度行
- 如果在 `requestAnimationFrame` flush、buffer flush 或 computed 渲染里把每个 chunk 直接 `join('\\n')` -> 进度条刷屏，属于错误实现

### 5. Good/Base/Bad Cases
- Good: 实时任务日志、执行日志详情、日志文件详情对同一份包含裸 `\r` 的内容展示结果一致
- Base: 没有 `\r` 的普通多行日志，仍按原有 `pre-wrap` 展示
- Bad: 任务页能单行刷新，但“执行日志”页和“日志文件”页又恢复成多行刷屏

### 6. Tests Required
- 前端验证: `cd web && npm run build`
- 手工回归点:
  - 任务页 `LogViewer` 中查看运行中的进度条脚本
  - 执行日志页打开同一任务的日志详情
  - 日志文件弹窗查看对应落盘文件

### 7. Wrong vs Correct
#### Wrong
```ts
detailContent.value += sseBuffer.join('\n') + '\n'
```

```ts
if (commitBoundary) {
  pushLogLine()
}
```

#### Correct
```ts
detailContent.value = mergeTerminalText(detailContent.value, chunk)
```

```ts
if (commitBoundary && !endedWithLineBreak && !sawCarriageReturn) {
  pushLogLine()
}
```

## Scenario: 代码编辑器（CodeMirror 6 默认引擎 + Monaco 可选引擎）

> v3.2.0（issue #109-2）把编辑器从 Monaco 换成了 CodeMirror 6。
> **本节整体取代了原来的「Monaco 本地静态资源与加载探测」一节** ——
> 被删掉的是那一整套**加载管线**：「运行期 AMD 加载 + 本地 `/monaco/vs` 资源探测 + CDN 兜底 +
> 构建后整目录拷贝」，连同 `web/scripts/copy-monaco-assets.mjs`、`web/src/utils/monaco.ts`、
> `@monaco-editor/loader`、`vite-plugin-monaco-editor` 一起删除。
> 在旧提交、旧发布说明里看到那套契约，那是历史陈述，**不要照着往回加**。
>
> v3.2.2（issue #114）把 **Monaco 这个包**作为可切换的第二引擎加了回来，但走的是**另一条路**：
> `monaco-editor@0.56.0` 精确版本 + `monaco-editor/editor/editor.api` 裁剪 ESM 导入 +
> `await import()` 懒加载，产物由 Vite 打进 `dist/assets/`。
> 也就是说上面那条禁令**一个字都没作废**：仍然没有运行期加载器、没有 CDN 兜底、
> 没有构建后资源拷贝，`server/main.go` 的静态白名单一行没动（`assets` 本来就覆盖了）。
> **禁的是那套管线，不是 Monaco 本身。**

### 1. Scope / Trigger
- Trigger: 修改下面「2. Signatures」列出的任意一个文件，
  或它们那 5 个调用点（脚本管理页 / 配置文件页 / 代码运行器 / 调试弹窗 / 版本对比弹窗）时必须看本节。
- 为什么 CodeMirror 是默认引擎、而且 `auto` 在触摸设备上**永远不会**选 Monaco：
  Monaco 是**自绘编辑器** —— 文本渲染在 `.view-lines` 里、原生选择被关掉，
  选区与光标是它自己画的 DOM 层，触摸事件被内部手势层接管。
  于是移动端「长按出系统菜单 / 双击出选择手柄 / 按住拖动光标」三条**只要还用 Monaco 渲染就都不可能满足**，
  不是「少配了某个选项」。CodeMirror 6 的内容区是 `contenteditable`，选区就是原生 `Selection`。
- 这段话在 v3.2.0 是「为什么换引擎」的理由；v3.2.2 之后它换了个位置继续生效 ——
  它是 `resolveEditorEngine()` 里那两条**硬回落**（coarse pointer / 窄屏 → `codemirror`）的唯一依据。
  别看到「现在有两个引擎了」就把那两条改成可配。

### 2. Signatures

**组件（2 个分发层 + 4 个引擎实现）**
- 共用编辑器分发层: `web/src/components/CodeEditor.vue`（6 个具名导出也在这个文件里）
- 差异编辑器分发层: `web/src/components/CodeDiffEditor.vue`
- CodeMirror 实现: `web/src/components/CodeMirrorEditor.vue` / `CodeMirrorDiffEditor.vue`（`@codemirror/merge`）
- Monaco 实现: `web/src/components/MonacoEditor.vue` / `MonacoDiffEditor.vue`

**utils**
- 引擎偏好与 `auto` 解析: `web/src/utils/editorEngine.ts`
- Monaco 的**唯一**导入边界: `web/src/utils/monacoEngine.ts`
- 语言映射 + 主题（两个引擎共用）: `web/src/utils/codeEditor.ts` ——
  `resolveCodeEditorLanguage()` / `buildCodeEditorTheme()` / `isCodeEditorDark()` /
  `resolveMonacoLanguage()` / `defineMonacoTheme()`
- CodeMirror 侧自建扩展: `web/src/utils/codeMinimap.ts`（缩略图）、`web/src/utils/indentGuides.ts`（缩进参考线）

**依赖**
- `@codemirror/{state,view,language,commands,search,autocomplete,merge,legacy-modes}` + `@codemirror/lang-*` + `@lezer/highlight`
- `monaco-editor`：`package.json` 里是**精确版本 `0.56.0`、不带 `^`**（全表唯一一条没有 caret 的依赖）。
  `monacoEngine.ts` 里那一长串 contrib / language 深路径 import 走的是包内私有路径，
  它自己的注释就记了两处 0.56 专属事实：`exports` 映射换过写法
  （`monaco-editor/editor/editor.api` 才对，老教程里的 `monaco-editor/esm/vs/editor/editor.api`
  会被解析成 `esm/vs/esm/vs/...` 直接 404），以及 `languages/definitions/` 下没有 json 目录。
  想放开成 caret 的话，先把那份 import 清单逐条在新版本上验一遍再说。

**这几条否定式全都仍然成立**
- **没有**运行期加载器、**没有** CDN 兜底、**没有**构建后资源拷贝：CodeMirror 由 Vite 直接打包。
- Monaco 是同一句话的另一半：它走 **ESM + Vite code-split**，**不是** AMD。
  `from 'monaco-editor/...'` 全仓只允许出现在 `utils/monacoEngine.ts`，
  其余地方一律 `await import('@/utils/monacoEngine')`（要标类型只能 `import type { MonacoApi }`）。
  产物落 `dist/assets/monaco-*.js`，由 `vite.config.ts` 的 `manualChunks` 单独成块。

### 3. Contracts

#### 具名导出（`CodeEditor.vue` 顶部的普通 `<script>` 块，共 6 个）
- **自动换行**：`EditorWordWrap` / `readStoredEditorWordWrap()` / `persistEditorWordWrap()`，
  localStorage 键固定 `dd:editor:word_wrap`，默认 `'on'`。
- **三个视图开关**：`EditorViewOption`（`'minimap' | 'indent_guides' | 'whitespace'`）/
  `readStoredEditorViewOption(name)` / `persistEditorViewOption(name, value)`，
  键分别是 `dd:editor:minimap` / `dd:editor:indent_guides` / `dd:editor:whitespace`。
- ⚠️ **三个默认值刻意不同**：缩进参考线 `true`，缩略图与空白符 `false`。
  判据是「打开它会不会打扰到不需要它的人」（缩略图要吃掉正文右侧 64px，空白符给每个空格画灰点），
  别顺手统一成一个值。
- 这 6 个导出**必须留在 `CodeEditor.vue`**：脚本页与配置文件页按名字引用它们。
  两个引擎实现不从这里 import 任何东西（偏好的值是页面读出来、当 prop 传下去的），所以不存在循环依赖。

#### 引擎偏好（`utils/editorEngine.ts`）
- `EditorEngine = 'auto' | 'codemirror' | 'monaco'`，解析后 `ResolvedEditorEngine = 'codemirror' | 'monaco'`；
  localStorage 键 `dd:editor:engine`，默认 `'auto'`，只认两个显式值、其余一律回落 `auto`。
- `persistEditorEngine()` 写完存储**必须**派发 `EDITOR_ENGINE_CHANGE_EVENT`（`'dd:editor-engine-change'`），
  且派发要放在 try/catch **之外** —— 隐私模式下写不进存储时，本次切换仍然必须生效。
  漏掉事件的表现是「菜单里切了、已经开着的那个编辑器纹丝不动，要刷新页面才生效」，不报错。
  两个分发层都靠监听它来重新解析引擎，且解析时**重新读一遍 localStorage**（存储才是唯一真源）。
- `resolveEditorEngine()` 里 **coarse pointer 与 ≤ `TABLET_BREAKPOINT`（1024）是硬回落 `codemirror`**，
  且**先判指针再判宽度**，顺序不能反：只看宽度会漏掉 1024~1366 的平板横屏与触屏笔电。
- `auto` **只在挂载时解析一次**，刻意不接 `useResponsive()` 的响应式宽度：
  响应式会让「桌面窗口从 1100 拖到 900」当场拆掉 Monaco 重建 CodeMirror，撤销历史 / 光标 / 滚动位置全丢。
- 阈值从 `useResponsive` 具名导入，**不要在这里重抄一个 `1024`**。

#### props（普通编辑器 9 个，差异编辑器 8 个，分发层与两个实现逐字相同）
- 普通编辑器：`modelValue` / `language` / `readonly` / `minHeight` / `fillHeight` /
  `wordWrap`（默认 `'on'`）/ `minimap` / `indentGuides` / `showWhitespace`（后三个默认 **`false`**）。
  后三个的默认值等于「加这些功能之前的行为」，所以不传它们的调用点（调试弹窗 / 代码运行器）一个像素都不变；
  注意它**不等于**偏好本身的默认值（参考线偏好默认是开的，由页面侧读出来再传进来）。
- 差异编辑器：`originalValue` / `modifiedValue` / `language` / `readonly` / `renderSideBySide` /
  `ignoreTrimWhitespace` / `hideUnchangedRegions` / `contextLineCount`。无 emit、无 `defineExpose`。
- 🔴 **一边加 prop，另一边必须同步加**。分发层是逐个显式 `:xxx="props.xxx"` 往下传的
  （刻意不写 `v-bind="props"` —— 那样 vue-tsc 就逐个查不了类型），两边对不上不报错，
  只会在切到某个引擎时静默丢掉一个开关。

#### 根 class 与 CSS 变量（🔴 两个引擎必须逐字相同）
- 普通编辑器：根 class 固定 `code-editor-wrapper`（+ `--fill`），最小高度变量固定 `--code-editor-min-height`，
  内层容器 `code-editor-container`。
- 差异编辑器：根 class 固定 `code-diff-wrapper`，内层 `code-diff-container`。
- **不要**因为「这是 Monaco 的文件」就改回 `monaco-editor-wrapper` / `--monaco-editor-min-height` ——
  被删掉那版 Monaco 用的正是这套名字，照搬回来是**静默失效**：
  `config-file/index.vue` 那条 `.editor-card :deep(.code-editor-wrapper) { min-height: 560px }`
  给窄屏兜的下限会失灵，`ScriptsEditorPane.vue` 的 `.code-editor { flex: 1; height: 100%; min-height: 0 }`
  也是穿透到这个根节点上的。表现是编辑器高度塌陷，而构建与 vue-tsc 全绿。
- 唯一允许两边不同的是差异编辑器的内层宽度：CodeMirror 侧 `.code-diff-container` 是
  `calc(100% - 10px)`（给自绘的差异总览标尺留槽），Monaco 侧必须是 `100%`（它的标尺画在编辑器内部）。
  照抄过去会多出一条 10px 死带。

#### 分发层的模板形状（🔴 `CodeEditor.vue` 与 `CodeDiffEditor.vue` 都适用）
- 必须是**单个 `<component :is>` 根节点**：不套 wrapper `<div>`、**不在根上放注释**、**不写 `<style>`**。
- 套 wrapper 的后果：三个调用点靠 `$attrs` 穿透给编辑器根节点加样式 ——
  `ScriptsEditorPane` 传 `class="code-editor"`，调试弹窗与代码运行器传内联
  `style="height: 100%; min-height: 0"`，版本对比弹窗传 `class="version-diff-editor"`
  （`flex: 1 1 0; min-height: 0`，只对弹窗 flex 容器的**直接子元素**成立）。
  套一层之后这些 class / style 落在中间那层 div 上，真正的编辑器根节点一点样式都拿不到，
  表现是高度塌陷或把弹窗顶穿，而构建与类型检查全绿。
- 在根上放注释的后果：dev 构建会保留注释节点、根退化成 Fragment，
  透传要靠 Vue 的 dev 专用 Fragment 透传路径兜 —— 平白让 **dev 与 prod 走两条不同的路径**。
- 写 `<style scoped>` 没有意义：scoped 样式只能命中子组件的根节点，
  `.code-editor-container` 与那几条 `:deep(.cm-*)` 都命中不到，它们必须跟着各自的实现走。

#### 每次输入即时 emit
- **每次输入即时 `emit('update:modelValue')`**：CodeMirror 侧在 `EditorView.updateListener` 里判 `docChanged`，
  Monaco 侧在 `onDidChangeModelContent` 里。等失焦才 emit 会让「未保存」角标、保存按钮 disabled、
  调试弹窗的脏标记全部滞后。
- 两侧都要先与 `props.modelValue` 比一次再 emit，否则外部同步进来的值会和父组件转成回环。

#### 运行期改配：两个引擎各有各的唯一姿势 🔴
- **CodeMirror 侧：可重配的选项一律用 `Compartment`。** 当前 7 个：
  `language` / `readonly` / `wordWrap` / `minimap` / `indentGuides` / `showWhitespace` / 主题。
  新增可配项时「create 的 `extensions` + `Compartment.of` + `watch` 里 `reconfigure`」**三处必须一起补**。
  （光标横向跟随刻意挂在 `wordWrap` 那个 compartment 里 —— 换行开着时它本来就不会横向溢出，
  不必再多一个 compartment 和一个 watch。）
- **Monaco 侧：运行期改配一律 `editor.updateOptions({...})`。**
  新增可配项时「create 的 `options` + `updateOptions` + `watch`」**三处必须一起补**。
- **换语言是 Monaco 侧的例外**：必须 `monaco.editor.setModelLanguage(model, id)`。
  语言挂在 **model** 上，`updateOptions` 里的 `language` 只对 `create` 生效。
- 两边的失效模式**完全相同且同样安静**：点了开关没反应、不报错、`npm run build` 与 `vue-tsc` 全绿。
  两个版本的 Wrong/Correct 见下面第 7 节。
- Monaco 侧另有两个「必须显式给、不能吃默认值」的选项：
  `renderWhitespace` 关掉时要给 `'none'`（默认是 `'selection'`，等于没关干净、只是「选中才显示」）；
  `renderLineHighlight` 要给 `'all'`（默认 `'line'` 不涂行号栏那一格，而 CodeMirror 侧同时开着
  `highlightActiveLine()` 与 `highlightActiveLineGutter()`，不给就是换个引擎当前行少半截底色）。

#### 主题
- **主题必须吃 `--dd-editor-bg-color` / `--dd-editor-fg-color`**，并监听 `PANEL_APPEARANCE_CHANGE_EVENT` 重绘 ——
  编辑器底色是设置页的用户可配项（`editor_background_color`），写死颜色等于把这个功能废掉。
- **Monaco 侧不能只在「明暗翻转了」时才换主题**：它的 `colors` 表只吃字面 hex、塞不进 `var()`
  （塞了会被解析成正红），底色是被**烘进**主题数据里的。用户只改了底色没切明暗时，
  CodeMirror 侧靠 `var()` 自动重绘、主题都不用动，Monaco 侧必须重新 `defineTheme`。
  这一层差异统一收在 `codeEditor.ts` 的 `defineMonacoTheme()` 里，两个 Monaco 组件都调它。
- 明暗二选一的颜色（语法色 / 行号色 / 选区色 / 差异标尺的红绿）只能在 JS 里按
  `isCodeEditorDark()` 判一次 —— 底色是用户可配项，明暗规则只能有一处真源，
  否则改了默认底色只同步到一边，表现是「浅色底上一条深色标尺」。

#### 只在 CodeMirror 侧成立的两条（Monaco 侧写了是死代码）
- **移动端三件套不能少**：`spellcheck="false"` / `autocapitalize="off"` / `autocorrect="off"`。
  手机输入法默认句首大写 + 自动纠错，会**静默改坏脚本内容**。
- **≤768px 内容区字号提到 16px**：`index.html` 的 viewport 没有 `maximum-scale`（也不该加），
  14px 输入区在 iOS 上聚焦会自动放大整页。
- 这两条不必往 Monaco 侧补：它是自绘编辑器，正文字号来自 JS 的 `fontSize`、不吃容器 CSS `font-size`；
  而且它**永远不会被发到触摸设备上**（`auto` 硬回落，显式选 `monaco` 的用户是自己做的选择）。

#### 自建 CodeMirror 扩展的两条铁律（缩略图 / 缩进参考线）
> 这两条是 `codeMinimap.ts` 与 `indentGuides.ts` 的命门，也是「为什么不装现成的社区包」的答案。
> 它们守的是同一件事：**本编辑器刻意没有启用 `drawSelection()`，内容区靠的是原生 `Selection`。**

- **缩略图的 DOM 必须挂在 `view.dom`（`.cm-editor`），绝不能碰 `view.contentDOM`。**
  CodeMirror 的 `DOMObserver` **只**监听 `contentDOM`，且 `childList + subtree` 全开。
  往里插一个节点再删掉（社区包 `@replit/codemirror-minimap` 每帧插一个 `div.cm-line` 量字体就是这么干的）
  会被读成一次真实 DOM 变更：`readMutation → markDirty → DOMChange → applyDOMChange`
  → 发现文本其实没变 → 强制 `view.update([])` → **把原生选区整个重写一遍**，
  手机长按菜单与选择手柄当场作废。
  同理 `touch-action: none` 只能加在缩略图自己身上，漏到 `.cm-content` / `.cm-scroller`
  会把触摸滚动和「按住拖动光标」一起废掉。
  几何一律走**像素**（`contentHeight` / `lineBlockAtHeight`）不走行数 —— 走行数在自动换行与折叠下会对不上。
- **缩进参考线必须用 `Decoration.line` + CSS 背景，不能用 `Decoration.widget`。**
  widget 会往 `.cm-line` 里塞真实 DOM 节点（还会顺带插一对 `.cm-widgetBuffer` 零宽 span），
  那些节点会落进原生选区范围，影响长按选择的落点，也可能被系统「拷贝」抄进剪贴板。
  `Decoration.line` 只往**已经存在**的 `.cm-line` 上加 class 和 style，一个新节点都不建，
  线是 `repeating-linear-gradient` 画的 —— 背景不是内容，进不了选区、也拷不走。
  写样式时只能用 `background-*` **长写法**：`background:` 简写会把 `background-color` 一并重置掉，
  当前行高亮（`.cm-activeLine` 只设了 `background-color`）会消失，且只在光标所在那一行复现。
- 同源约束还有一条：版本对比的差异总览标尺是 `.code-diff-container` 的**兄弟节点**，
  刻意做成编辑器 DOM 之外的覆盖物而不是 `ViewPlugin` —— 插件想接点击就得挂
  `EditorView.domEventHandlers`，那正好是这个编辑器绝不能碰的东西。别把它「优化」成插件。

### 4. Validation & Error Matrix
- CodeMirror 侧改了 prop 但没配 Compartment / watch -> 点了开关没反应、按钮还高亮，**构建与 vue-tsc 全绿**
- Monaco 侧只改了 `create()` 的 options、没补 `updateOptions` 的 watch -> **同样是点了开关没反应**，
  同样不报错、同样全绿；换语言若走 `updateOptions({ language })` 而不是 `setModelLanguage()`，
  表现是「切了文件高亮还停在上一个文件的语言上」
- 改了根 class / CSS 变量名没同步页面 `:deep()` -> 编辑器高度塌陷或移动端 `min-height` 失效，同样全绿
- 分发层套了 wrapper div 或在根上放了注释 -> `$attrs` 落到中间层，高度塌陷 / dev 与 prod 行为不一致
- 主题写死颜色 -> 设置页自定义底色失效、暗色串色；Monaco 侧只在明暗翻转时换主题 -> 改底色纹丝不动
- `monaco-editor` 的静态 import 出现在 `monacoEngine.ts` 以外的地方（含漏写 `import type` 的 `type`）
  -> Rollup 把 monaco chunk 提升成入口的静态依赖，`index.html` 里冒出 monaco 的
  `modulepreload` / `stylesheet`，**没切引擎的用户白下约 1 MiB**。构建成功、页面能用，纯静默劣化
- `dist/monaco` **目录**又出现 -> 说明有人把 `copy-monaco-assets.mjs` 那套老管线加回来了
  （注意与 `dist/assets/monaco-*.js` 区分，后者是本版的正常产物）

### 5. Good/Base/Bad Cases
- Good: 新增可配项时两个引擎一起补 —— CodeMirror 侧「create 的 extensions + Compartment + watch」，
  Monaco 侧「create 的 options + updateOptions + watch」，各自三处齐全
- Good: 新增 prop 时分发层、两个实现三个文件同步改，且分发层仍然逐个显式往下传
- Base: 至少保证四个调用点默认值等于改动前行为（调试弹窗与代码运行器不传 `wordWrap` / `minimap` /
  `indentGuides` / `showWhitespace`，吃 `'on'` / `false` / `false` / `false`）
- Bad: 只改 `EditorState.create({extensions})`（或只改 `monaco.editor.create()` 的 options），然后以为改完了
- Bad: 只给一个引擎加了开关，另一个引擎不动 —— 用户切一下引擎，那个开关就没反应了
- Bad: 把 CodeMirror 侧自绘的差异标尺移植到 Monaco 侧 —— Monaco 的 `renderOverviewRuler` 原生就画这条，
  两条会打架

### 6. Tests Required
- 前端验证: `cd web && npm run build`（含 `vue-tsc -b`）
- 构建后检查（`.github/workflows/checks.yml` 里「断言 Monaco 已打包且未进首屏」那一步已经有这对正反断言，
  位置在 `build:demo` 之前，因为那一步会先清空 `dist`）:
  - `web/dist` 下**不应**出现 `monaco` **目录** —— 出现即说明老管线被加回来了
  - `dist/assets/monaco-*.js` **必须存在** —— 不存在说明 Monaco 压根没被打包，
    此时下面那条反向断言变成恒真的空转门禁
  - `dist/index.html` 里**不得**出现指向 `/assets/monaco-` 的 `modulepreload` 或 `stylesheet` ——
    出现即懒加载失效，最常见成因是 `vite.config.ts` 里把 `vite/preload-helper` 钉到 `app-core` 的
    那条 `manualChunks` 规则被删了
- 手工回归点（仓库没有前端测试，这一段是唯一保护）。
  🔴 **除标注了引擎的条目外，下面每一条都要在 CodeMirror 与 Monaco 两个引擎下各跑一遍**:
  - 四处编辑器 ×（只读 / 编辑）×（Wrap on / off）
  - 三个视图开关（缩略图 / 缩进参考线 / 空白符）各自开关一次都真的生效
  - 保存后「未保存」角标消失；退出编辑态后确实改不动
  - 明暗主题切换、设置页自定义编辑器底色即时生效
  - 版本对比弹窗：并排 / 统一两种模式，「忽略空白差异」开关；滚动条侧的差异标记能点、能跳
  - 引擎切换本身：齿轮菜单里切一下，**当前已经开着的编辑器**就换掉（不用刷新）；刷新后仍然记得
  - **仅 CodeMirror 引擎下**：移动端长按出系统菜单、双击出选择手柄、按住能拖动光标。
    🔴 这三条**在 Monaco 下是不可能满足的**，那正是 `auto` 在触摸设备上硬回落 CodeMirror 的理由。
    别把它们写成无条件验收项 —— 后人在 Monaco 下测一遍会误判成回归。

### 7. Wrong vs Correct

两个引擎是同一条铁律的两半，下面两组例子是双胞胎：**只在创建那一刻读一次的配置，挂载后改它完全没反应且不报错。**

#### Wrong
```ts
// CodeMirror：只在创建那一刻读一次 —— 挂载后再切 prop 完全没反应，也不报错
EditorState.create({ extensions: [props.wordWrap === 'on' ? EditorView.lineWrapping : []] })
```

```ts
// Monaco：同一个毛病。create 的 options 也只读一次，
// 而且 language 只对 create 生效 —— 后面再 updateOptions 传 language 是彻底的空操作。
monaco.editor.create(el, { minimap: { enabled: props.minimap }, language: resolveMonacoLanguage(props.language) })
```

#### Correct
```ts
// CodeMirror：Compartment + watch，两处一起写
const wrapCompartment = new Compartment()
// create 时：wrapCompartment.of(...)
watch(() => props.wordWrap, (value) => {
  view?.dispatch({ effects: wrapCompartment.reconfigure(value === 'on' ? EditorView.lineWrapping : []) })
})
```

```ts
// Monaco：普通选项走 updateOptions；语言挂在 model 上，只能走 setModelLanguage
watch(() => props.minimap, (enabled) => {
  editor?.updateOptions({ minimap: { enabled } })
})
watch(() => props.language, (next) => {
  const model = editor?.getModel()
  if (!model || !monacoApi) return
  monacoApi.editor.setModelLanguage(model, resolveMonacoLanguage(next))
})
```

---

## Scenario: 通知渠道表单 / 系统配置表单的字段定义

### 1. Scope / Trigger

改动涉及「某个渠道有哪些配置字段」或「系统设置页显示哪些配置项」时触发。
这两类知识的**真源在服务端**，Web 不得再持有副本。

### 2. Signatures

- `GET /api/notifications/types` -> `[{type, name, fields: NotifyFieldDefinition[]}]`
  真源：`server/model/notify_channel_registry.go`（22 渠道 / 90 字段槽 / 56 唯一键）
- `GET /api/configs` -> `{data: {key: {...}}}`
  真源：`server/model/system_config_registry.go`（47 项）

### 3. Contracts

`NotifyFieldDefinition`：`key` / `label` / `widget` / `placeholder` /
`required` / `default` / `options[{value,label}]` / `show_when{key,values}`

- `widget` **只有四种**：`input` / `password` / `textarea` / `select`
- `show_when` **只支持单键等值命中**，不支持 OR / 表达式
- 渲染器读的是 `field.widget`，**不是 `field.type`**

`SystemConfigDefinition` 额外下发 `label` / `group_label` / `order` /
`secret` / `min` / `max`。注意 `order` 的第一项是 0，
服务端**绝不能给它加 `omitempty`**。

### 4. Validation & Error Matrix

- 通知渠道 config 的值必须**全是字符串** -> 非字符串的可逆类型服务端会转换，
  对象/数组返回 400 并点名键
- `notifier.go` 读了但 registry 没声明 -> `go test ./service` 红
- registry 声明了但 `notifier.go` 不读 -> 同上，**反方向也红**

### 5. Good/Base/Bad Cases

- **Good**：加渠道字段只改 `notify_channel_registry.go`，Web 与 APP 自动跟上
- **Base**：schema 缺表达力（如条件 options）时，先扩 schema 再让两端消费
- **Bad**：在 `index.vue` 里加一张字段表 / 在 computed 里做 `widget -> type`
  映射保住旧模板 —— 都是把漂移源搬回来

### 6. Tests Required

`server/service/notifier_schema_binding_test.go` 用 `go/ast` 扫
`notifier.go` 的 `cfg["..."]`，与 registry **双向**断言相等。
已做双向突变验证：两个方向各改一处，测试都会红。**不要绕过它。**

### 7. Wrong vs Correct

#### Wrong
```ts
// web/src/views/notifications/index.vue —— 曾经的 225 行
const configFields = computed(() => {
  switch (form.type) {
    case 'telegram': return [{ key: 'token', label: 'Bot Token', type: 'input' }, ...]
```

#### Correct
```ts
const currentChannelFields = computed(() =>
  channelTypes.value.find(t => t.type === form.type)?.fields ?? [])
```

> 历史：这份知识曾在 `notifier.go` / `index.vue` / APP / `apiData.ts`
> 四处各存一份，并且已经漂移过 —— `apiData.ts` 的 wecom_app 消息类型漏了
> `mpnews`，而另外两处都有。

> **系统配置侧走的是「专属表单 + schema 兜底」两层**：
> `useSettingsConfig.ts` 的 `configForm` 保留 41 个键的硬编码，因为它们绑着
> SVG 上传、取色器实时预览、图片压缩、镜像源弹窗、备份内容 CSV ↔ 复选框等定制控件；
> 其余项由 `settings/systemConfigSchema.ts` + `components/ExtraConfigCard.vue`
> 按服务端 schema 兜底渲染。**谁进兜底区是拿 `configForm` 的键去减算出来的**，
> 所以服务端加配置项时 Web 不用改，它会自己冒出来。
>
> 三项只读见 `READ_ONLY_CONFIG_KEYS`（巡检写入的机器状态 + `ddp service install`
> 写入的安装事实）：渲染成只读行，不隐藏、不回写。
> 保存统一走 `submitConfigs`，**只提交改动过的键** —— 服务端 `BatchSet` 逐键写入、
> 中途 400 时前面的键已经落库，全量回写会造成半保存状态。
