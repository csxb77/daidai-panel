# 后端质量规范

> 目标是让后端改动稳定、兼容、容易回溯，而不是为了形式统一牺牲可维护性。

---

## 禁止项

- 禁止只改一层，不检查对应 handler/service/model/database 联动。
- 禁止为了抽象强拆很多小函数，让主流程反而难读。
- 禁止绕开 `pkg/response` 随意发散响应格式。
- 禁止忽视本地 SQLite 老数据兼容问题。
- 禁止在没有验证的情况下声称后端改动完成。

---

## 必做项

- 先搜索现有实现，优先复用已有分层和已有模式。
- 复杂边界和兼容逻辑补中文注释。
- 数据库字段/索引/迁移相关改动必须检查 `database/database.go`。
- 安全相关逻辑要检查成功、失败、限流、鉴权分支。
- 改后端逻辑后默认跑测试。

---

## 测试要求

后端改动后默认执行：

```bash
cd server
go test ./...
```

如果本次修改没有对应测试覆盖点，也要在结果里明确说明还有哪些残余风险。

---

## 场景：定时任务默认列表排序与置顶优先级

### 1. Scope / Trigger

- 触发：修改 `server/handler/task_query.go` 中任务列表默认排序、`is_pinned`、`status`、`sort_order` 相关逻辑时必须看本节。
- 原因：置顶是用户主动设置的展示优先级。如果默认排序先按启用 / 禁用状态分组，再按 `is_pinned` 排序，禁用后的置顶任务会被普通启用任务挤到后面，表现为“禁用任务不能保持置顶”。

### 2. Contracts

- 默认任务列表排序必须先尊重 `is_pinned DESC`，再按任务状态分组。
- 已置顶任务即使状态变为禁用，也必须继续保留在置顶区域。
- 置顶区内部再按状态分组、`sort_order`、创建时间和 ID 保持稳定顺序。
- 自定义视图排序没有命中差异时，最终兜底排序也必须使用同一套默认规则，避免默认列表和视图列表表现不一致。

### 3. Tests Required

- 禁用但已置顶任务应排在普通启用任务前面。
- 运行中 / 排队中 / 启用状态变化不能打乱同组内 `sort_order` 的稳定顺序。
- 修改排序时至少运行：

```bash
cd server
go test ./handler -run "TestTaskListKeepsPinnedDisabledTasksInPinnedArea|TestTaskListKeepsStableOrderWhenTaskStatusChangesToRunning"
go test ./...
```

---

## 场景：开机运行任务每天自动触发一次

### 1. Scope / Trigger

- 触发：修改 `server/service/scheduler_v2.go` 的 `EnqueueStartupTasks()`、`RunNow()`，或修改 `model.Task` 的任务类型 / 启动触发状态字段时必须看本节。
- 原因：「开机运行」是面板启动流程的自动触发能力，不等同于“每次服务进程启动都重复执行”。面板更新、容器重建、电脑重启都会导致服务再次启动，如果不持久化当天自动触发状态，同一天可能重复跑用户原本只想每天启动自动跑一次的任务。

### 2. Signatures

- 自动触发入口：`func (s *SchedulerV2) EnqueueStartupTasks() int`
- 手动触发入口：`func (s *SchedulerV2) RunNow(taskID uint) error`
- 任务字段：`Task.LastStartupAutoRunDate string`
- 数据库字段：`tasks.last_startup_auto_run_date VARCHAR(10) DEFAULT ''`

### 3. Contracts

- 开机运行任务的自动触发按面板本地日期限流，同一个任务同一天只能由 `EnqueueStartupTasks()` 自动入队一次。
- 自动触发成功入队后，必须立即写入 `last_startup_auto_run_date=当天日期`，避免任务执行结束回到「启用」后，当天再次重启又被自动入队。
- 手动运行必须继续走 `RunNow()`，不得读取或修改 `last_startup_auto_run_date`，确保用户当天仍可手动运行多次。
- 旧日期、空字符串、`NULL` 都表示当天尚未自动触发，可以在当天首次启动时自动入队。
- 新字段必须在 `database.EnsureColumns()` 中补列，保证已有 SQLite 用户升级后无需手动迁移。

### 4. Validation & Error Matrix

- `last_startup_auto_run_date == today` -> `EnqueueStartupTasks()` 跳过该任务。
- `last_startup_auto_run_date == ''` 或旧日期 -> `EnqueueStartupTasks()` 正常入队，并写入今天日期。
- 自动入队失败（队列满 / scheduler stopped）-> 不写入今天日期，允许后续启动再尝试。
- 手动 `RunNow()` -> 不检查今天日期，正常入队或返回原有队列错误。
- 老库缺字段 -> 启动时通过 `EnsureColumns()` 自动补列，不能要求用户手工改库。

### 5. Good/Base/Bad Cases

- Good：早上第一次启动面板，开机运行任务自动执行；上午面板更新重启，任务不再自动重复执行；用户手动点「运行」仍可执行。
- Base：昨天自动执行过，今天首次启动面板时再次自动执行。
- Bad：直接用 `last_run_at` 判断是否今天跑过，因为手动运行也会更新 `last_run_at`，会误伤「手动可以再次执行」的需求。

### 6. Tests Required

- 同一天第一次 `EnqueueStartupTasks()` 返回 1，写入 `LastStartupAutoRunDate=today`。
- 模拟任务完成后状态回到启用，同一天第二次 `EnqueueStartupTasks()` 返回 0。
- `RunNow()` 在 `LastStartupAutoRunDate=today` 时仍可多次入队。
- 旧日期任务在新的一天仍可自动入队。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestSchedulerV2" -count=1
go test ./...
```

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：每次面板服务启动都重新入队，更新/重启会导致同一天重复自动跑。
database.DB.Where("status = ? AND task_type = ?", model.TaskStatusEnabled, model.TaskTypeStartup).Find(&tasks)
```

```go
// 错误：用 last_run_at 限制会把用户手动运行也算进去，破坏“手动可多次执行”。
database.DB.Where("DATE(last_run_at) <> ?", today).Find(&tasks)
```

#### Correct

```go
// 正确：只限制开机运行的自动触发日期，手动 RunNow 不看这个字段。
database.DB.
  Where("status = ? AND task_type = ?", model.TaskStatusEnabled, model.TaskTypeStartup).
  Where("last_startup_auto_run_date IS NULL OR last_startup_auto_run_date <> ?", today).
  Find(&tasks)
```

---

## 场景：主动停止任务的 Aborted 独立状态

### 1. Scope / Trigger

- 触发：修改任务手动停止、批量停止、定时停止、CLI stop、任务执行完成结算、通知发送、`notify_on_abort` 字段、统计接口或前端终止状态展示时必须看本节。
- 原因：手动停止和定时停止通常是用户主动规划的终止，不应被当成脚本异常失败，也不应伪装成自然成功。必须用独立 `Aborted` 状态表达“任务被用户或计划主动终止”。

### 2. Signatures

- 停止标记：`func markManualStop(taskID uint)`
- 跨包停止标记：`func MarkManualStop(taskID uint)`
- 完成结算覆盖：`func applyManualStopOverride(taskID uint, runStatus, logStatus int) (finalRun int, finalLog int, aborted bool)`
- 单任务停止入口：`PUT /api/v1/tasks/:id/stop`
- 批量停止入口：`PUT /api/v1/tasks/batch` with `action="stop"`
- 定时停止入口：`func (s *SchedulerV2) stopTaskBySchedule(taskID uint)`
- CLI 停止入口：`ddp stop`
- 任务运行状态：`model.RunAborted`
- 日志状态：`model.LogStatusAborted`
- 任务字段：`Task.NotifyOnAbort bool`
- 数据库字段：`tasks.notify_on_abort BOOLEAN DEFAULT 0`
- 前端字段：`notify_on_abort`

### 3. Contracts

- 手动停止、批量停止、定时停止和 CLI stop 必须统一写入 `RunAborted` / `LogStatusAborted`。
- 主动停止命中停止标记后，任务完成结算必须覆盖为 Aborted，不能按退出码写失败。
- Aborted 不触发成功通知，也不触发失败通知；仅当 `notify_on_abort=true` 时发送终止通知。
- Aborted 必须单独统计，不能增加成功数或失败数；成功率只使用 `success / (success + failed)`。
- 停止标记必须在杀进程之前写入，避免任务完成 `defer` 先执行导致仍被结算成失败。
- 定时停止使用 PID 兜底杀进程时，也必须打停止标记，不能只 `KillProcessByPid`。
- 自然失败、依赖失败、脚本超时、面板异常退出导致的中断仍按失败处理，不得被误改成 Aborted。
- 新字段必须在 `database.EnsureColumns()` 中补列，保证老 SQLite 数据库升级后默认不发送终止通知。

### 4. Validation & Error Matrix

- 主动停止 / 批量停止 / 定时停止 / CLI stop -> 运行状态 Aborted、日志状态 Aborted。
- `notify_on_abort=false` -> 不发送成功 / 失败 / 终止通知。
- `notify_on_abort=true` -> 只发送「任务已终止」通知。
- 自然成功 + 未停止 -> 成功状态和成功通知保持原逻辑。
- 自然失败 + 未停止 -> 失败状态和失败通知保持原逻辑。
- 老库缺 `notify_on_abort` -> 启动时自动补列，默认 `0`。
- 测试或异常启动阶段 `GetTaskExecutor()==nil` -> 停止接口不得 panic，应继续走状态 / 日志兜底更新。

### 5. Good/Base/Bad Cases

- Good：长驻任务配置了定时停止，晚上到点被停止后显示「已终止」，不发送失败通知，不增加失败统计，仪表盘终止统计 +1。
- Base：用户手动点击停止，任务列表和日志列表显示「已终止」，成功率不受影响。
- Bad：定时停止只杀 PID 不打停止标记，任务执行完成时收到非 0 退出码，被误判为失败。
- Bad：把 Aborted 当成功写入统计，导致用户分不清自然完成和计划终止。

### 6. Tests Required

- `applyManualStopOverride`：
  - 命中主动停止标记时应强制返回 `RunAborted` / `LogStatusAborted`。
  - 标记读即清，重复调用不得继续覆盖状态。
  - 未打停止标记的自然失败不能被改成 Aborted。
- handler：
  - 创建任务时 `notify_on_abort` 能保存并回传。
  - `PUT /tasks/:id/stop` 把运行中日志改成 `LogStatusAborted`，任务 `last_run_status` 改成 `RunAborted`。
- scheduler：
  - 定时停止必须打停止标记，并把运行中日志兜底改成 `LogStatusAborted`。
- notification / stats：
  - Aborted 通知标题、正文、context 与成功 / 失败通知区分开。
  - Dashboard / stats 必须返回 aborted 独立统计，成功率不被 Aborted 拉低。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestApplyManualStopOverride|TestConsumeManualStop|TestManualStop|TestSchedulerV2|TestBuildTaskExecutionNotification" -count=1
go test ./handler -run "TestStopTaskMarksRunningLogAborted|TestCreateTaskPersistsNotifyOnAbortSwitch|TestSystemDashboardAndStatsReportAbortedSeparately" -count=1
go test ./...
```

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：定时停止只杀进程，不打停止标记，完成结算会把退出码当普通失败。
if task.PID != nil {
    KillProcessByPid(*task.PID)
}
```

```go
// 错误：命中停止标记后伪装成自然成功，统计上无法区分主动终止和真实成功。
if consumeManualStop(taskID) {
    return model.RunSuccess, model.LogStatusSuccess, true
}
```

#### Correct

```go
// 正确：杀进程前先打停止标记，完成结算时统一写入 Aborted。
markManualStop(taskID)
KillProcessByPid(*task.PID)
```

```go
// 正确：主动停止使用独立 Aborted 状态，通知和统计都走单独口径。
if !consumeManualStop(taskID) {
    return runStatus, logStatus, false
}
return model.RunAborted, model.LogStatusAborted, true
```

---

## 场景：反代 CORS 同源判断与外部端口

### 1. Scope / Trigger

- 触发：修改 `server/middleware/cors.go`、反代头解析、登录 403 / CORS 拦截相关逻辑时必须看本节。
- 原因：群晖、飞牛、Nginx Proxy Manager 等多层反代可能只把公网域名写入 `Host` / `X-Forwarded-Host`，却丢掉浏览器实际访问的外部端口。例如浏览器 `Origin=https://dd.example.com:5888`，后端只看到 `Host=dd.example.com`，如果直接比较完整 `host:port` 会误判跨域。

### 2. Contracts

- 公网域名不能默认全放开，仍必须满足以下任一条件：
  - 命中 `config.yaml` 的 `cors.origins`
  - `Origin` 域名与 `Host` / `X-Forwarded-Host` / `X-Original-Host` / RFC 7239 `Forwarded host=` 一致
  - 私有/Loopback IP 来源命中已有局域网放行逻辑
- 如果 `X-Forwarded-Port` 明确存在，必须与 `Origin` 端口一致；端口冲突时必须拒绝。
- 如果反代没有传 `X-Forwarded-Port`，但域名一致且候选 host 没有端口，可以按“反代丢失外部端口”兼容放行。
- 不允许为了修复 NAS 反代问题把 `Allow-Origin` 改成 `*`，因为登录接口携带认证能力，公网开放会扩大攻击面。

### 3. Tests Required

- `Origin=https://域名:端口` + `X-Forwarded-Host=同域名` + 无 `X-Forwarded-Port` -> 放行
- `Origin=https://域名:端口` + `X-Forwarded-Host=同域名` + `X-Forwarded-Port=同端口` -> 放行
- `Origin=https://域名:端口` + `X-Forwarded-Host=同域名` + `X-Forwarded-Port=不同端口` -> 拒绝
- `Origin=https://恶意域名:端口` + `X-Forwarded-Host=面板域名` -> 拒绝

---

## 评审检查清单

- 分层是否清晰，职责是否仍然合理？
- 是否引入了不必要的新抽象？
- 响应结构是否与现有接口风格一致？
- 数据库兼容和迁移是否考虑到了？
- 是否执行了 `go test ./...`？

---

## 场景：订阅 Git 仓库路径过滤

### 1. Scope / Trigger

- 触发：修改 `server/service/subscription.go` 里 Git 订阅拉取、`sub_path`、`whitelist`、`blacklist`、sparse checkout 相关逻辑时必须看本节。
- 原因：Git sparse-checkout 的 cone 模式会默认保留仓库根目录文件，不能满足“只拉指定子目录 / 白名单文件”的产品语义。

### 2. Signatures

- 入口：`pullGitRepoWithCallback(ctx context.Context, sub *model.Subscription, authCfg gitAuthConfig, emit PullCallback) (string, error)`
- 路径过滤构造：`buildSubscriptionSparseCheckoutPatterns(sub *model.Subscription) []string`
- sparse 应用：`applySparseCheckout(ctx context.Context, repoDir string, sub *model.Subscription, env []string, emit PullCallback) error`

### 3. Contracts

- `sub.SubPath`：逗号分隔，优先级最高，表示真实工作区只检出这些仓库路径。
- `sub.Whitelist`：未设置 `SubPath` 时参与真实检出范围；历史语义是“路径包含匹配”，实现时要尽量保持这个直觉。
- `sub.Blacklist`：参与 sparse 排除规则；只有黑名单时先包含全部，再通过 `!pattern` 排除。
- 首次 clone 有路径过滤时必须使用 `--no-checkout`，先设置 sparse 规则，再 `git checkout HEAD`。
- GitHub 等支持 partial clone 的远端可以加 `--filter=blob:none`，但不能依赖所有 Git 服务都支持；不支持时应退化为普通浅克隆。

### 4. Validation & Error Matrix

- `sparse-checkout init` 失败 → 返回 `sparse-checkout init 失败: %w`
- `sparse-checkout set` 失败 → 返回 `sparse-checkout set 失败: %w`
- 清空过滤后关闭 sparse 失败 → 返回 `关闭 sparse-checkout 失败: %w`
- `ctx` 取消 → 沿用拉库链路的 `拉取已停止`

### 5. Good/Base/Bad Cases

- Good：`SubPath="scripts/daily"` 后，`scripts/daily/keep.js` 存在，`root.js` 和 `scripts/other/skip.js` 不落盘。
- Base：未设置子目录 / 白名单 / 黑名单时，保持完整仓库检出。
- Bad：使用 `git sparse-checkout init --cone` 后只设置子目录，因为 cone 模式仍会保留根目录文件。

### 6. Tests Required

- 子目录回归：断言指定子目录文件存在，仓库根文件和其它目录文件不存在。
- 白名单回归：断言白名单命中文件存在，非白名单文件不存在。
- 清空过滤回归：已有 sparse 仓库清空配置后，应能恢复完整检出。

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：先 clone 全部，再用 cone sparse，会短暂全量落盘且根目录文件仍会保留。
args := []string{"clone", "--depth", "1", remoteURL, destDir}
_ = exec.CommandContext(ctx, "git", args...)
_ = exec.CommandContext(ctx, "git", "sparse-checkout", "init", "--cone")
```

#### Correct

```go
// 正确：先不检出工作区，设置 no-cone sparse 规则后再 checkout。
args := []string{"clone", "--depth", "1", "--filter=blob:none", "--no-checkout", remoteURL, destDir}
_ = exec.CommandContext(ctx, "git", args...)
_ = exec.CommandContext(ctx, "git", "sparse-checkout", "init", "--no-cone")
_ = exec.CommandContext(ctx, "git", "sparse-checkout", "set", "--no-cone", "scripts/daily")
_ = exec.CommandContext(ctx, "git", "checkout", "HEAD")
```

---

## 场景：Node.js 依赖安装清单修复

### 1. Scope / Trigger

- 触发：修改 `server/handler/deps.go`、`server/service/dependency_auto_install.go`、`server/service/backup_runtime.go` 里 npm install / uninstall / reinstall / auto-install 相关逻辑时必须看本节。
- 原因：所有 Node.js 依赖共用 `data/deps/nodejs/package.json` 和 `package-lock.json`；多个 npm 进程并发写同一文件，或历史坏文件残留，都会导致 `npm ERR! code EJSONPARSE`。

### 2. Signatures

- 加锁：`LockNodePackageOperation() func()`
- 安装命令：`NewNpmInstallCommand(packageName string) (*exec.Cmd, error)`
- 卸载命令：`NewNpmUninstallCommand(packageName string, force bool) (*exec.Cmd, error)`
- 清单校验：`ensureNodePackageManifest(nodeDir string) error`

### 3. Contracts

- 所有 npm install / uninstall / force uninstall / backup restore reinstall / auto-install 都必须持有 `LockNodePackageOperation()` 返回的锁，直到 npm 进程结束。
- 执行 npm 前必须先校验 `data/deps/nodejs/package.json`。
- `package.json` 不存在时，写入最小合法清单：`private: true` 和 `dependencies: {}`。
- `package.json` 非法或 `dependencies` 不是对象时，先备份为 `package.json.broken-*`，再根据现有 `node_modules/*/package.json` 重建依赖清单。
- npm 环境必须保留代理和 npm 镜像：`NpmInstallEnv(AppendProxyEnv(...), CurrentNpmMirror())`。

### 4. Validation & Error Matrix

- 创建 Node.js 依赖目录失败 → `创建 Node.js 依赖目录失败: %w`
- 读取 package.json 失败 → `读取 Node.js package.json 失败: %w`
- 备份坏 package.json 失败 → `备份损坏的 Node.js package.json 失败: %w`
- 写入新 package.json 失败 → `写入 Node.js package.json 失败: %w`

### 5. Good/Base/Bad Cases

- Good：坏 `package.json` 末尾多 `}`，安装前自动备份并重建，之后 npm 可以继续安装。
- Base：无 `package.json`，自动创建合法最小清单。
- Bad：直接并发执行多个 `exec.Command("npm", "install", "--prefix", nodeDir, name)`，容易并发写坏 JSON。

### 6. Tests Required

- 损坏清单回归：写入非法 `package.json`，断言修复后 JSON 可解析、原文件被备份为 `package.json.broken-*`。
- 依赖保留回归：已有 `node_modules/axios/package.json` 时，重建后的 `dependencies` 包含 `axios` 版本。
- 命令链路回归：handler/service 中所有 Node.js npm 调用都必须通过 `NewNpmInstallCommand` / `NewNpmUninstallCommand`。

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：多个 goroutine 可能同时写同一个 package.json，且坏 JSON 不会被修复。
cmd := exec.Command("npm", "install", "--prefix", filepath.Join(depsDir, "nodejs"), name)
out, err := cmd.CombinedOutput()
```

#### Correct

```go
// 正确：持锁到 npm 进程结束，并在命令创建前修复 package.json。
unlock := service.LockNodePackageOperation()
defer unlock()

cmd, err := service.NewNpmInstallCommand(name)
if err != nil {
    return err
}
out, err := cmd.CombinedOutput()
```

---

## 场景：脚本目录污染隔离与 Windows 资源监控

### 1. Scope / Trigger

- 触发：修改 `server/service/resource_monitor*.go`、`server/handler/script_file_ops.go`、`server/service/backup*.go`、`server/main.go` 里脚本目录扫描、备份恢复、资源监控或启动期清理逻辑时必须看本节。
- 原因：Windows 运行态如果只实现 Linux 资源采集，仪表板会长期显示 `0 B / 0 B`；脚本目录如果混入 `%SystemDrive%` 这类异常目录，会污染脚本管理、统计和备份恢复链路。

### 2. Signatures

- Windows 资源补齐：`fillWindowsResourceInfo(info *ResourceInfo)`
- 异常脚本判断：`ShouldIgnoreScriptEntryName(name string) bool`
- 绝对路径判断：`ShouldIgnoreScriptPath(scriptsDir, targetPath string) bool`
- 相对路径判断：`ShouldIgnoreScriptRelativePath(relPath string) bool`
- 启动期隔离：`QuarantineUnexpectedScriptEntriesOnStartup()`

### 3. Contracts

- `GetResourceInfo()` 在 Windows 下必须返回可用的 `memory_total`、`memory_used`、`disk_total`、`disk_used`，不能继续全量为 `0`。
- 启动时如果脚本目录顶层命中 `%SystemDrive%` 等异常目录，必须自动移动到 `data/quarantine/scripts/`，而不是继续暴露给脚本管理页。
- 脚本文件树、脚本统计、备份打包、备份恢复复制链路都必须复用同一套 `ShouldIgnoreScript*` 判断，避免有的地方隐藏、有的地方继续打包。
- 备份恢复遇到命中异常规则的脚本相对路径时必须跳过，不能把污染目录重新写回脚本根目录。
- 备份恢复写回脚本目录、日志目录、`panel.log` 这类 live 资源时，禁止“先清空 live，再逐步复制”；必须先把新内容完整写入同目录 staging 位置，确认成功后再原子切换到 live 目录/文件。

### 4. Validation & Error Matrix

- Windows 资源采集 API 调用失败 → 返回 0，但不能影响服务启动。
- 脚本目录扫描遇到异常目录 → 展示层/统计层跳过；启动期尝试隔离到 quarantine。
- quarantine 目标重名 → 追加 `.duplicate-N` 后缀，不能覆盖旧证据目录。
- 备份恢复中遇到 `%SystemDrive%/...` 相对路径 → 直接跳过，不报错中断整个恢复流程。
- 备份恢复 staging 构建失败 → 直接返回错误，live 目录/文件必须保持恢复前原样，不能出现“旧数据已删，新数据没写完”的半恢复状态。

### 5. Good/Base/Bad Cases

- Good：Windows 仪表板显示真实内存/磁盘占用；脚本页只显示正常脚本文件；异常 `%SystemDrive%` 目录被移到 `data/quarantine/scripts/%SystemDrive%`。
- Base：Linux 继续沿用 `/proc` 和 `df` 采集逻辑，不受 Windows 分支影响。
- Bad：只在前端隐藏 `%SystemDrive%`，但备份仍把异常目录继续打包；或只修仪表板展示，不修 `/api/system/info` 的 0 值来源；或恢复时先删 live 目录，复制中途失败后留下空目录/半目录。

### 6. Tests Required

- `TestShouldIgnoreScriptEntryName`
- `TestShouldIgnoreScriptPath`
- `TestShouldIgnoreScriptRelativePath`
- `TestQuarantineUnexpectedScriptEntriesOnStartup`
- `TestCreateBackupSkipsQuarantinedScriptEntriesInArchive`
- `TestRestoreScriptFilesKeepsLiveDataWhenStageCopyFails`
- `TestRestoreLogFilesKeepsLivePanelLogWhenStageCopyFails`
- `TestRestoreQingLongScriptsKeepsLiveDataWhenStageCopyFails`
- 回归验证：
  - `go test ./...`
  - Windows 运行态下 `/api/system/info` 不再返回 `memory_total=0 && disk_total=0`
  - 脚本管理页不再显示 `%SystemDrive%`

### 7. Wrong vs Correct

#### Wrong

```go
if runtime.GOOS == "linux" {
    info.MemoryTotal, info.MemoryUsed, info.MemoryFree = getLinuxMemory()
}
// Windows 下什么都不做，最终资源信息全是 0
```

```go
filepath.Walk(scriptsDir, func(path string, info os.FileInfo, err error) error {
    if err != nil || info.IsDir() {
        return nil
    }
    count++
    return nil
})
```

```go
// 错误：先清空 live 目录，再边拷贝边恢复；复制中途失败会把旧数据一起打掉。
_ = clearDirectoryContents(config.C.Data.ScriptsDir)
_ = copyDirectoryContents(sourceDir, config.C.Data.ScriptsDir)
```

#### Correct

```go
if runtime.GOOS == "windows" {
    fillWindowsResourceInfo(&info)
}
```

```go
filepath.Walk(scriptsDir, func(path string, info os.FileInfo, err error) error {
    if err != nil || info == nil {
        return nil
    }
    if info.IsDir() && service.ShouldIgnoreScriptPath(scriptsDir, path) {
        return filepath.SkipDir
    }
    if !info.IsDir() && service.ShouldIgnoreScriptPath(scriptsDir, path) {
        return nil
    }
    count++
    return nil
})
```

```go
// 正确：先把恢复结果写到 staging，成功后再切换 live 目录。
_ = restoreDirectoryWithStage(config.C.Data.ScriptsDir, func(stageDir string) error {
    return copyDirectoryContents(sourceDir, stageDir)
})
```

---

## 场景：备份恢复环境变量启用状态

### 1. Scope / Trigger

- 触发：修改 `server/service/backup_runtime.go`、`server/service/backup_types.go`、青龙备份转换或环境变量备份恢复逻辑时必须看本节。
- 原因：`model.EnvVar.Enabled` 是 `bool`，并带有 `gorm:"default:true"`。如果恢复时直接 `Create(&model.EnvVar{Enabled:false})`，GORM 会把 `false` 当成零值交给 SQLite 默认值，最终恢复成 `true`。

### 2. Signatures

- 备份字段：`BackupEnvVar.Enabled *bool json:"enabled,omitempty"`
- 导出转换：`backupEnvVarFromModel(item model.EnvVar) BackupEnvVar`
- 恢复转换：`modelEnvVarFromBackup(item BackupEnvVar) model.EnvVar`
- 恢复入口：`restoreEnvVars(tx *gorm.DB, envVars []BackupEnvVar) error`

### 3. Contracts

- 新备份必须明确写出环境变量 `enabled=true/false`，不能因为 `false` 是零值而丢字段。
- 恢复时如果 `enabled=false` 明确存在，最终数据库里的 `env_vars.enabled` 必须是 `false`。
- 老备份如果缺少 `enabled` 字段，必须按历史行为默认恢复为启用，避免把旧备份环境变量批量恢复成禁用。
- 青龙备份转换得到的环境变量也必须走同一套 `BackupEnvVar` 转换，不能直接把 `model.EnvVar` 塞进备份清单。

### 4. Validation & Error Matrix

- `enabled=false` 明确存在 -> 恢复后 `env_vars.enabled=false`
- `enabled=true` 明确存在 -> 恢复后 `env_vars.enabled=true`
- `enabled` 字段缺失 -> 恢复后 `env_vars.enabled=true`
- 恢复写入失败 -> 回滚本次备份恢复事务

### 5. Good/Base/Bad Cases

- Good：备份里一启用一禁用两个环境变量，恢复后状态完全一致。
- Base：旧备份没有 `enabled` 字段，恢复后变量保持启用，兼容老用户数据。
- Bad：恢复时直接 `tx.Create(&model.EnvVar{Enabled:false})`，结果被 SQLite 默认值覆盖成启用。

### 6. Tests Required

- `TestRestoreBackupManifestReplacesCoreBusinessData`：断言启用和禁用环境变量都按备份状态恢复。
- `TestRestoreBackupManifestDefaultsLegacyEnvEnabledWhenMissing`：断言老备份缺少 `enabled` 字段时默认启用。
- `TestCreateBackupIncludesSelectedContentInArchive`：断言导出的备份清单包含 `enabled=false`。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestRestoreBackupManifest|TestCreateBackup|TestBuildQingLongManifest" -count=1
```

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：Enabled=false 会被 GORM 当成零值，配合 default:true 后容易恢复成 true。
env := model.EnvVar{Name: item.Name, Value: item.Value, Enabled: false}
_ = tx.Create(&env).Error
```

#### Correct

```go
// 正确：用 *bool 区分字段缺失和明确 false，创建后对禁用状态做兜底写回。
env := modelEnvVarFromBackup(item)
shouldRestoreDisabled := !env.Enabled
if err := tx.Create(&env).Error; err != nil {
    return err
}
if shouldRestoreDisabled {
    return tx.Model(&model.EnvVar{}).Where("id = ?", env.ID).Update("enabled", false).Error
}
```

---

## 场景：默认 Python 版本与不可用运行时兜底

### 1. Scope / Trigger

- 触发：修改 `server/service/python_runtime.go`、`server/handler/deps.go`、`web/src/views/deps/index.vue` 时必须看本节。
- 原因：系统默认 Python 版本可能配置成 `3.12`，但当前机器真实可用的是 `3.10/3.11`。如果前端直接拿默认版本作为展示版本，会出现页面默认查询不可用解释器、列表空白甚至接口报错。

### 2. Signatures

- 后端默认版本：`DefaultPythonVersion() string`
- 后端运行时列表：`PythonRuntimeInfos() []PythonRuntimeInfo`
- 前端展示版本选择：`resolveDisplayPythonVersion(runtimes, defaultVersion)`

### 3. Contracts

- 后端 `default_version` 继续返回系统真实默认值，不能因为当前机器暂时没装对应解释器就偷偷改配置。
- 前端“当前展示的 Python 版本”和“系统默认 Python 版本”允许不同：
  - 默认版本可用 → 直接展示默认版本
  - 默认版本不可用 → 自动切到第一个可用版本
- 页面必须明确提示用户：当前展示版本与系统默认版本分别是什么。

### 4. Validation & Error Matrix

- 默认版本可用 → `pythonVersion === pythonDefaultVersion`
- 默认版本不可用但存在其它可用版本 → 自动切到首个 `available=true` 的版本
- 所有版本都不可用 → 回退到默认版本或首个候选版本，但页面必须展示“需先安装”

### 5. Good/Base/Bad Cases

- Good：默认 `3.12` 不可用、`3.10` 可用时，页面自动展示 `3.10` 列表，同时说明“系统默认版本仍是 3.12”。
- Base：默认 `3.11` 可用时，页面继续展示 `3.11`。
- Bad：默认 `3.12` 不可用时，页面仍强行请求 `3.12`，导致空白或报错。

### 6. Tests Required

- 前端构建：`cd web && npm run build`
- 后端测试：`cd server && go test ./...`
- 运行态验收：依赖页在默认版本不可用时仍能打开并自动展示可用版本列表

### 7. Wrong vs Correct

#### Wrong

```ts
pythonDefaultVersion.value = res.default_version || "3.12"
pythonVersion.value = pythonVersion.value || pythonDefaultVersion.value
```

#### Correct

```ts
pythonDefaultVersion.value = res.default_version || "3.12"
pythonVersion.value = resolveDisplayPythonVersion(
  pythonRuntimes.value,
  pythonDefaultVersion.value,
)
```

---

## 场景：Docker Python 单版本 / 全版本镜像拆分

### 1. Scope / Trigger

- 触发：修改 `Dockerfile`、`Dockerfile.debian`、`docker/install-python-runtimes.sh`、`.github/workflows/release.yml`、`server/service/python_runtime.go`、`server/service/runtime_exec.go`、`server/handler/deps.go` 或任务 Python 版本选择逻辑时必须看本节。
- 原因：默认 Docker 镜像不再同时塞入 `3.10 / 3.11 / 3.12` 三套 Python。单版本镜像需要只暴露当前小版本，并在老用户从三版本镜像升级后清理多余托管 venv，避免依赖页和任务执行继续指向已移除版本。

### 2. Signatures

- 构建参数：`PYTHON_RUNTIME_MODE=single|all`
- 构建参数：`PYTHON_RUNTIME_VERSION=3.10|3.11|3.12`
- 运行时环境：`DAIDAI_PYTHON_RUNTIME_MODE`
- 运行时环境：`DAIDAI_PYTHON_VERSION`
- 当前镜像版本列表：`CurrentPythonRuntimeVersions() []string`
- 单版本识别：`SinglePythonRuntimeVersion() (string, bool)`
- 启动策略修正：`ApplySinglePythonRuntimePolicyOnStartup()`
- 启动目录清理：`CleanupManagedPythonArtifactsOnStartup()`

### 3. Contracts

- `latest` / `debian` 默认使用 `PYTHON_RUNTIME_MODE=single` 和 `PYTHON_RUNTIME_VERSION=3.12`，只内置 Python `3.12`。
- `latest3.10`、`latest3.11`、`debian3.10`、`debian3.11` 分别只内置对应 Python 小版本。
- `latestall`、`debianall` 使用 `PYTHON_RUNTIME_MODE=all`，必须同时安装 `3.10 / 3.11 / 3.12`。
- Alpine 的 `latest3.10`、`latest3.11`、`latestall` 只发布 `amd64 / arm64`；如果某个平台没有 python-build-standalone 资产，脚本必须失败而不是回退成错误版本。默认 `latest` 可以在 32 位平台保留发行版 Python 3.12。
- 单版本镜像启动后，后端 `SupportedPythonVersions()` / 依赖安装版本 / 任务表单选项必须只暴露当前镜像小版本。
- 单版本镜像启动后，必须把 `python_default_version` 和历史任务 `python_version` 切回当前镜像小版本；默认 `latest` / `debian` 即 `3.12`。
- 单版本镜像启动清理只能删除 `data/deps/python/<不支持版本>` 这类面板托管 Python 小版本目录，不能删除脚本、日志、备份、Node.js 依赖或未知目录。
- `all` 镜像不得清理 `3.10 / 3.11 / 3.12` 任意一个托管目录。

### 4. Tests Required

- `SupportedPythonVersions()` 在 `DAIDAI_PYTHON_RUNTIME_MODE=single` 时只返回当前版本。
- `CleanupManagedPythonArtifactsOnStartup()` 在 single `3.12` 时删除 `3.10 / 3.11` 目录并保留 `3.12`。
- `CleanupManagedPythonArtifactsOnStartup()` 在 `all` 时保留三个版本目录。
- `ApplySinglePythonRuntimePolicyOnStartup()` 必须把旧默认版本和旧任务版本切回镜像版本。
- Python 依赖创建在 single 镜像里只创建当前小版本依赖记录。
- 发布 workflow 必须用 matrix 平台列表限制 Alpine 非默认 Python 变体，避免 32 位平台推送错误运行时镜像。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestSupportedPythonVersions|TestCleanupManagedPythonArtifactsOnStartup|TestApplySinglePythonRuntimePolicy" -count=1
go test ./handler -run "TestPythonDependencyCreate" -count=1
```

---

## 场景：auto_update_last_checked_at 配置键注册

### 1. Scope / Trigger

- 触发：修改系统设置概览、更新检查时间展示、`configApi.get('auto_update_last_checked_at')` 相关逻辑时必须看本节。
- 原因：前端会读取 `auto_update_last_checked_at`。如果后端未把它注册成正式配置键，`/api/configs/auto_update_last_checked_at` 会返回 404，页面虽然能兜底，但运行态会持续报错。

### 2. Signatures

- 前端读取：`configApi.get('auto_update_last_checked_at')`
- 后端注册：`newTrimmedStringConfig("auto_update_last_checked_at", "", "...", "network")`

### 3. Contracts

- 只要前端直接读取某个系统配置键，这个键就必须在 `registeredSystemConfigSpecs` 中注册。
- 该键允许为空字符串，表示“从未检查”。

### 4. Validation & Error Matrix

- 配置未写入数据库但已注册 → `GET /configs/:key` 返回默认值结构，不能再 404
- 配置已写入 → 返回实际保存值

### 5. Good/Base/Bad Cases

- Good：系统设置概览首次进入时显示“从未检查”，控制台和网络都不报错。
- Base：用户点过检查更新后，页面能显示最后检查时间。
- Bad：前端直接请求一个未注册配置键，导致 404。

### 6. Tests Required

- 后端测试：`cd server && go test ./...`
- 浏览器验收：系统设置概览不再触发 `/api/configs/auto_update_last_checked_at` 404

### 7. Wrong vs Correct

#### Wrong

```go
newBoolConfig("auto_update_enabled", "false", "...", "network")
// 忘记注册 auto_update_last_checked_at
```

#### Correct

```go
newBoolConfig("auto_update_enabled", "false", "...", "network")
newTrimmedStringConfig("auto_update_last_checked_at", "", "上次自动检查更新时间", "network")
```

---

## 场景：Windows 发布产物与源码一致性

### 1. Scope / Trigger

- 触发：修改 Windows 打包、`server/*.exe`、README Windows 发布说明、release workflow 时必须看本节。
- 原因：仓库源码目录如果长期保留手工构建或调试阶段的 `server/daidai-panel.exe`，很容易和当前源码脱节，导致“源码已修复，但本地 exe 仍是旧行为”。

### 2. Signatures

- GitHub Release Windows 构建：`.github/workflows/release.yml`
- Windows 正式产物名：`daidai-server.exe`
- 仓库开发态忽略：`.gitignore` 中应忽略 `server/daidai-panel.exe`、`server/ddp.exe`

### 3. Contracts

- 仓库源码目录中的本地 Windows 可执行文件不作为可信发布产物。
- 正式 Windows 发布包必须以 release workflow 使用 `-ldflags "-X daidai-panel/handler.Version=..."` 产出的 zip 为准。
- 本地开发产生的 `server/daidai-panel.exe`、`server/ddp.exe` 必须被 `.gitignore` 忽略，避免把旧二进制误提交到仓库。

### 4. Validation & Error Matrix

- 源码 `handler.Version` 已更新，但本地 exe 行为仍是旧接口 / 旧版本 → 优先检查是否误用了仓库里旧 exe，而不是当前源码构建产物。
- 工作树中出现 `server/daidai-panel.exe` 脏改动 → 视为发布一致性风险，不要混进功能提交。

### 5. Good/Base/Bad Cases

- Good：发布前用 workflow 或等价命令重新构建 Windows zip，并验证 `/api/system/version` 与源码版本一致。
- Base：开发阶段允许本地临时 exe 存在，但必须被 git 忽略。
- Bad：直接把仓库中历史遗留的 exe 当作正式发布产物发给用户。

### 6. Tests Required

- `go test ./...`
- Windows 产物启动后 `/api/system/version` 返回与本次源码一致的版本号
- `git status` 不应包含本地 exe 脏改动

### 7. Wrong vs Correct

#### Wrong

```text
源码修完后直接使用仓库里已有的 server/daidai-panel.exe 做验收或发版
```

#### Correct

```text
源码修完后重新构建 Windows 发布产物，验收时优先使用当前源码编译出的二进制或 GitHub Release workflow 产物
```

---

## 场景：Magisk / APatch 模块版 Python 版本对齐

### 1. Scope / Trigger

- 触发：修改 `server/service/python_runtime.go`、`server/service/runtime_exec.go`、`Magisk/service.sh`、模块运行时自检脚本时必须看本节。
- 原因：模块版当前通常只有一个容器内 `python3`，不保证真的同时存在 3.10 / 3.11 / 3.12 三套解释器。`v2.2.19` 起如果仍把默认 Python 版本硬绑到 `3.12`，老任务会统一报“Python 3.12 不可用”。

### 2. Signatures

- 模块运行态判断：`service.IsMagiskModuleRuntime() bool`
- 默认版本决策：`DefaultPythonVersion() string`
- 任务环境决策：`ResolvePythonVersionFromEnv(envVars map[string]string) string`
- 模块容器启动脚本：`Magisk/service.sh`

### 3. Contracts

- 模块版运行态下，默认 Python 版本必须优先跟随容器里真实 `python3` 小版本。
- 若任务 / 配置里保存的是 `3.12`，但模块当前真实 `python3` 是 `3.11`，且系统里也不存在额外 `python3.12`，运行时必须自动回退到 `3.11`。
- `Magisk/service.sh` 创建托管 venv 时，目录名必须使用真实 `python3` 小版本，不能硬编码 `deps/python/3.12`。
- Docker / Windows / 普通 Linux 多版本环境继续沿用原有多版本逻辑，不受模块版兼容分支影响。

### 4. Validation & Error Matrix

- 模块版 + 系统 `python3` 为 3.11 + 配置默认值为 3.12 -> 最终任务运行版本应回退到 3.11
- 模块版 + 系统里确实存在 `python3.12` -> 可以继续使用 3.12
- 非模块版 -> 不允许因为当前 `python3` 是 3.11 就偷偷改掉用户显式指定的 3.12

### 5. Good/Base/Bad Cases

- Good：用户从 `v2.2.10` 升级到 `v2.2.19+` 后，历史 Python 任务在 APatch / Magisk 设备上继续可跑，不因默认版本固定成 3.12 全挂。
- Base：模块版只有一个 `python3` 时，面板至少能稳定对齐到这个实际版本。
- Bad：容器里实际 `python3` 是 3.11，但 `service.sh` 仍创建 `deps/python/3.12`，后端再按严格版本校验把它判成不可用。

### 6. Tests Required

- 后端测试：`cd server && go test ./...`
- 回归点：
  - `TestDefaultPythonVersionFallsBackToActiveSystemPythonOnMagiskRuntime`
  - `TestResolvePythonVersionFromEnvFallsBackToActiveSystemPythonOnMagiskRuntime`
  - `TestMagiskServiceScriptExportsAndroidRuntimeEnv`

### 7. Wrong vs Correct
#### Wrong
```go
const defaultPythonRuntimeVersion = "3.12"
return defaultPythonRuntimeVersion
```

```sh
python3 -m venv "$DAIDAI_DIR/deps/python/3.12"
```

#### Correct
```go
return resolveEffectivePythonVersionForCurrentRuntime(version)
```

```sh
PY_MINOR=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
python3 -m venv "$DAIDAI_DIR/deps/python/$PY_MINOR"
```

---

## 场景：版本发布前预检

### 1. Scope / Trigger

- 触发：准备推送 `main`、打 `vX.Y.Z` tag、触发 `.github/workflows/release.yml` 之前必须看本节。
- 原因：这个仓库历史上多次出现“主 Release 已成功，但 Docker job 因缓存/平台问题报错”、“README / Magisk 版本号没同步”、“更新日志缺失或 title marker 缺失”这类可提前在本地发现的问题。

### 2. Signatures

- 预检脚本：`scripts/release-preflight.ps1 -Version X.Y.Z`
- 目标 workflow：`.github/workflows/release.yml`

### 3. Contracts

- 打 tag 前必须先运行一次 `scripts/release-preflight.ps1 -Version X.Y.Z`
- 预检至少覆盖：
  - Git 工作区干净
  - `docs/release-notes/vX.Y.Z.md` 存在且包含 `release-title`
  - README 最新稳定版、Magisk `module.prop`、`Magisk/update.json` 版本号已同步
  - `go test ./...` 通过
  - `npm run build` 通过
  - `release.yml` 基本语法检查通过（若本机有 `actionlint`）
  - 远端不存在同名 tag

### 4. Validation & Error Matrix

- 工作区不干净 -> 直接阻断发版
- 更新日志缺失 / title marker 缺失 -> 直接阻断发版
- 远端已存在同名 tag -> 直接阻断发版
- `actionlint` 不存在 -> 允许继续，但必须给出黄色告警而不是静默跳过

### 5. Good/Base/Bad Cases

- Good：先跑预检，再 push main、push tag；高频低级错误在本地就被拦住
- Base：即使没装 `actionlint`，也至少完成版本同步、构建、测试、tag 冲突检查
- Bad：直接打 tag 触发 CI，等远端失败后再补版本文件或更新日志

### 6. Tests Required

- 本地执行：`powershell -ExecutionPolicy Bypass -File .\scripts\release-preflight.ps1 -Version 2.2.20`
- 修改预检脚本后至少手动跑一次，确认脚本本身可用

### 7. Wrong vs Correct
#### Wrong
```text
改完代码 -> 直接 git push origin main && git push origin v2.2.20
```

#### Correct
```text
先跑 release-preflight -> 通过后再推 main 和 tag
```
