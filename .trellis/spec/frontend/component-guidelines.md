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

## 已知缺陷：移动端「全屏」弹窗实际只有 92vw

> 记录日期 2026-08-08，基线 v3.0.1，**未修复**。
> 本条写在这里而不是 Trellis task 里，是因为 `.git/info/exclude` 把 `/.trellis/`
> 整个排除了，task 目录只存在于本机；而这条缺陷需要跨机器、跨接手人保留。

**现象**：`≤768px` 下所有 `:fullscreen="dialogFullscreen"` 的弹窗，高度是满的，
左右各短 4vw，露出两条遮罩边。看起来像「全屏没做好」，实际是被样式覆盖了。

**根因是 CSS 层叠，不是写错**：

```scss
// Element Plus 自己的实现
.el-dialog            { width: var(--el-dialog-width, 50%); }   // 无 !important
.el-dialog.is-fullscreen { --el-dialog-width: 100%; height: 100%; }

// global.scss:1673-1675，在 @media screen and (max-width: 768px) 里
.el-dialog {
  --el-dialog-width: 92vw !important;
  width: 92vw !important;      // ← 带 !important，直接盖掉上面那条 width
}
```

EP 是**通过改变量**实现全屏的，而这里是**直接写 width 且带 `!important`**。
带 `!important` 的声明胜过不带的，与特异性无关，所以 `.is-fullscreen` 那条
`--el-dialog-width: 100%` 根本没机会参与计算。`global.scss:341-350` 的
`&.is-fullscreen` 块只处理了 `max-height` 与 margin，**没有 width**，补不上这个洞。

**影响面**：全站 40+ 个调用点（`useResponsive` 的 `dialogFullscreen` 几乎每个页面都在用）。

**已经有两处在局部绕它**，改的时候不要以为它们是历史遗留：
- `ScriptExecutionDialogs.vue:316-319`——注释明写「用双 class 提高特异性」
- `LogViewer.vue:1085-1088`——自己重新声明了一遍 `&.is-fullscreen`

**为什么不能直接把那两行删掉**：`92vw` 是给**非全屏**弹窗用的移动端宽度。
桌面端很多弹窗写死了 `width="600px"` / `"1100px"`，在窄屏上会溢出，这条兜底就是防它。
正确修法是让全屏态不受这条约束，例如在同一个 media 块里补
`.el-dialog.is-fullscreen { width: 100% !important; }`，而不是移除兜底。

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

## Scenario: Monaco 本地静态资源与加载探测

### 1. Scope / Trigger
- Trigger: 修改 `web/scripts/copy-monaco-assets.mjs`、`web/src/utils/monaco.ts`、`MonacoEditor.vue`、`MonacoDiffEditor.vue` 时必须看本节。
- 原因: Monaco 是运行时动态加载资源，不是普通的“构建期 import 即可”。如果只保留 `loader.js`、却删掉 `editor/`、`language/`、`assets/` 等目录，构建仍然会成功，但浏览器里编辑器会直接初始化失败。

### 2. Signatures
- 资源复制脚本: `web/scripts/copy-monaco-assets.mjs`
- 本地资源探测: `web/src/utils/monaco.ts`
- 本地资源根路径: `${import.meta.env.BASE_URL}monaco/vs`

### 3. Contracts
- `copy-monaco-assets.mjs` 不能再按“带 hash 的具体文件名白名单”删 Monaco 资源。
- 本地资源探测不能只检查 `loader.js` 是否存在，至少要检查稳定关键入口:
  - `loader.js`
  - `editor/editor.main.js`
  - `editor/editor.main.css`
  - `language/css/monaco.contribution.js`
  - `language/html/monaco.contribution.js`
  - `language/json/monaco.contribution.js`
  - `language/typescript/monaco.contribution.js`
- 当本地资源不完整时，允许回退 CDN；但如果本地资源完整，应优先使用本地，避免用户网络无法访问 CDN 时编辑器直接挂掉。

### 4. Validation & Error Matrix
- `loader.js` 存在，但 `editor/editor.main.js` 或 `language/*` 缺失 -> 视为本地资源不可用
- 构建通过，但浏览器里出现“编辑器加载失败，请检查网络或稍后重试” -> 优先检查 `dist/monaco/vs` 完整性，而不是先怀疑用户网络
- 本地资源完整 + CDN 不可达 -> 编辑器仍应能正常加载

### 5. Good/Base/Bad Cases
- Good: `dist/monaco/vs` 包含 `editor/`、`language/`、`assets/`、`basic-languages/`，用户离线或访问不了 CDN 也能打开编辑器
- Base: 本地资源缺失时回退 CDN，至少不误判“本地可用”
- Bad: 只探测 `loader.js`，或者继续按 hash 白名单裁剪 `vs` 目录

### 6. Tests Required
- 前端验证: `cd web && npm run build`
- 构建后检查:
  - `web/dist/monaco/vs/editor` 存在
  - `web/dist/monaco/vs/language` 存在
  - `web/dist/monaco/vs/assets` 存在
- 手工回归点:
  - 脚本编辑页能正常打开 Monaco 编辑器
  - 断网或阻断 CDN 时，本地编辑器仍能加载

### 7. Wrong vs Correct
#### Wrong
```js
const allowedTopLevelVsFiles = new Set([
  'editor.worker-abc123.js',
  'ts.worker-def456.js',
])
```

```ts
return `${import.meta.env.BASE_URL}monaco/vs/loader.js`
```

#### Correct
```js
copyDirectory(sourceDir, targetDir)
```

```ts
const LOCAL_MONACO_REQUIRED_FILES = [
  'loader.js',
  'editor/editor.main.js',
  'editor/editor.main.css',
  'language/css/monaco.contribution.js',
]
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
