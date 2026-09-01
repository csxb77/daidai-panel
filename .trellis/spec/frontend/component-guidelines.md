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

## Scenario: 代码编辑器（CodeMirror 6）

> v3.2.0（issue #109-2）把编辑器从 Monaco 换成了 CodeMirror 6。
> **本节整体取代了原来的「Monaco 本地静态资源与加载探测」一节** ——
> 那一整套「运行期 AMD 加载 + 本地 `/monaco/vs` 资源探测 + CDN 兜底 + 构建后整目录拷贝」
> 已经随 `web/scripts/copy-monaco-assets.mjs`、`web/src/utils/monaco.ts` 一起删除。
> 在旧提交、旧发布说明里看到那套契约，那是历史陈述，**不要照着往回加**。

### 1. Scope / Trigger
- Trigger: 修改 `web/src/components/CodeEditor.vue`、`CodeDiffEditor.vue`、`web/src/utils/codeEditor.ts`，
  或它们那 5 个调用点（脚本管理页 / 配置文件页 / 代码运行器 / 调试弹窗 / 版本对比弹窗）时必须看本节。
- 为什么换：Monaco 是**自绘编辑器** —— 文本渲染在 `.view-lines` 里、原生选择被关掉，
  选区与光标是它自己画的 DOM 层，触摸事件被内部手势层接管。
  于是移动端「长按出系统菜单 / 双击出选择手柄 / 按住拖动光标」三条**只要还用 Monaco 渲染就都不可能满足**，
  不是「少配了某个选项」。CodeMirror 6 的内容区是 `contenteditable`，选区就是原生 `Selection`。

### 2. Signatures
- 共用编辑器: `web/src/components/CodeEditor.vue`
- 差异编辑器: `web/src/components/CodeDiffEditor.vue`（`@codemirror/merge`）
- 语言映射 + 主题: `web/src/utils/codeEditor.ts`
- 依赖: `@codemirror/{state,view,language,commands,search,autocomplete,merge,legacy-modes}` + `@codemirror/lang-*` + `@lezer/highlight`
- **没有**运行期加载器、没有 CDN 兜底、没有构建后资源拷贝：CodeMirror 由 Vite 直接打包。

### 3. Contracts
- **具名导出必须原样保留**：`EditorWordWrap` / `readStoredEditorWordWrap()` / `persistEditorWordWrap()`，
  localStorage 键固定 `dd:editor:word_wrap`，脚本页与配置文件页共享同一份记忆。
- **props 契约**：`modelValue` / `language` / `readonly` / `minHeight` / `fillHeight` / `wordWrap`（默认 `'on'`）。
  根元素 class 固定 `code-editor-wrapper`（+ `--fill`）；差异编辑器是 `code-diff-wrapper`。
  改类名要连带改调用点页面里那些 `:deep()` 规则 —— 漏改是**构建与类型检查都发现不了的静默失效**。
- **每次输入即时 `emit('update:modelValue')`**（`EditorView.updateListener` 里判 `docChanged`）。
  等失焦才 emit 会让「未保存」角标、保存按钮 disabled、调试弹窗的脏标记全部滞后。
- **可重配的选项一律用 `Compartment`**：`readonly` / `wordWrap` / `language` / 主题。
  见下面第 7 节那条从 Monaco 时代继承下来的教训。
- **主题必须吃 `--dd-editor-bg-color` / `--dd-editor-fg-color`**，并监听 `PANEL_APPEARANCE_CHANGE_EVENT` 重绘 ——
  编辑器底色是设置页的用户可配项（`editor_background_color`），写死颜色等于把这个功能废掉。
- **移动端三件套不能少**：`spellcheck="false"` / `autocapitalize="off"` / `autocorrect="off"`。
  手机输入法默认句首大写 + 自动纠错，会**静默改坏脚本内容**。
- **≤768px 内容区字号提到 16px**：`index.html` 的 viewport 没有 `maximum-scale`（也不该加），
  14px 输入区在 iOS 上聚焦会自动放大整页。

### 4. Validation & Error Matrix
- 改了 prop 但没配 Compartment / watch -> 点了开关没反应、按钮还高亮，**构建与 vue-tsc 全绿**
- 改了根 class 没同步页面 `:deep()` -> 编辑器高度塌陷或移动端 `min-height` 失效，同样全绿
- 主题写死颜色 -> 设置页自定义底色失效、暗色串色
- `dist/monaco` 又出现 -> 说明有人把 `copy-monaco-assets.mjs` 加回来了

### 5. Good/Base/Bad Cases
- Good: 新增可配项时「create 的 extensions + Compartment reconfigure + watch」三处一起补
- Base: 至少保证四个调用点默认值等于改动前行为（调试弹窗与代码运行器不传 `wordWrap`，吃默认 `'on'`）
- Bad: 只改 `EditorState.create({extensions})`，然后以为改完了

### 6. Tests Required
- 前端验证: `cd web && npm run build`（含 `vue-tsc -b`）
- 构建后检查: `web/dist` 下**不应**再出现 `monaco` 目录
- 手工回归点（仓库没有前端测试，这一段是唯一保护）:
  - 四处编辑器 ×（只读 / 编辑）×（Wrap on / off）
  - 保存后「未保存」角标消失；退出编辑态后确实改不动
  - 明暗主题切换、设置页自定义编辑器底色即时生效
  - **移动端**：长按出系统菜单、双击出选择手柄、按住能拖动光标（这三条就是换引擎的全部目的）
  - 版本对比弹窗：并排 / 统一两种模式，「忽略空白差异」开关

### 7. Wrong vs Correct
#### Wrong
```ts
// 只在创建那一刻读一次 —— 挂载后再切 prop 完全没反应，也不报错
EditorState.create({ extensions: [props.wordWrap === 'on' ? EditorView.lineWrapping : []] })
```

#### Correct
```ts
const wrapCompartment = new Compartment()
// create 时：wrapCompartment.of(...)
watch(() => props.wordWrap, (value) => {
  view?.dispatch({ effects: wrapCompartment.reconfigure(value === 'on' ? EditorView.lineWrapping : []) })
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
