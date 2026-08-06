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

## 场景：任务并发闸门与执行槽位

### 1. Scope / Trigger

- 触发：修改 `server/service/scheduler_v2.go` 的 worker 循环 / `executeTask()` / 槽位管理、`server/service/task_executor.go` 的 `OnTaskExecuting()` / `RunTask()`、`server/service/scheduler_manager.go` 的调度器初始化与关停，或改动随机延迟链路时必须看本节。
- 原因：`max_concurrent_tasks`（UI 文案「定时任务最大并发数」）与「不允许多实例」曾长期**完全失效**——worker 在 `OnTaskExecuting` 里 `go runTask(...)` 后立即返回，`defer removeRunningTask` 随即触发，闸门只覆盖了几乎瞬时的「派发」窗口。用户把并发数设为 1 也不起作用，且这个失效是静默的：没有任何日志或报错，只能靠读代码发现。

### 2. Signatures

- 并发闸门：`func (s *SchedulerV2) executeTask(req *ExecutionRequest)`（**必须阻塞到任务真正结束**）
- 槽位获取：`func (s *SchedulerV2) acquireRunningSlot(req *ExecutionRequest) (int64, bool)`
- 槽位释放：`func (s *SchedulerV2) removeRunningTask(taskID uint, goid int64)`
- 执行入口：`func (e *TaskExecutor) RunTask(req *ExecutionRequest)`（同步，含全部重试）
- 准备入口：`func (e *TaskExecutor) OnTaskExecuting(req *ExecutionRequest) error`（只准备，**不得阻塞到任务结束**）
- 延迟计算：`func (e *TaskExecutor) ResolveExecutionDelay(req *ExecutionRequest) time.Duration`（只算时长，**不得 sleep**）
- 延迟等待：`func (s *SchedulerV2) EnqueueDelayed(delay time.Duration, reqFunc func() *ExecutionRequest)`
- 关停两段：`func (s *SchedulerV2) SignalStop()` / `func (s *SchedulerV2) WaitWorkers(timeout time.Duration) bool`
- 并发数热生效：`func (s *SchedulerV2) SetWorkerCount(n int) (previous int, applied int)` / `func (s *SchedulerV2) GetWorkerCount() int` / `func ApplySchedulerWorkerCount()`
- 配置键：`max_concurrent_tasks` -> `SchedulerConfig.WorkerCount`（启动时）-> `SetWorkerCount()`（保存后热生效）
- 请求字段：`ExecutionRequest.DelayResolved bool`、包内 `taskLog *model.TaskLog` / `tinyLog *TinyLog`

### 3. Contracts

- **worker 即并发名额**：`WorkerCount = N` 必须等价于「任意时刻最多 N 个任务处于执行中」。`executeTask` 从取得槽位到返回，必须完整覆盖任务执行全过程（含 `MaxRetries` 重试与 `RetryInterval` 等待）。
- `SchedulerEventHandler` 的职责分离不可合并：`OnTaskExecuting` 只做依赖检查、解析命令、建立日志记录；真正执行必须在 `RunTask` 中同步完成。合并会让 `OnTaskStarted` 在任务结束后才被调用，语义倒置。
- **随机延迟不得占用槽位**：延迟必须在 worker 取得槽位**之前**完成，实现方式是 `EnqueueDelayed` 重新入队。若在槽位内 sleep，`max_concurrent_tasks=1` + 全局延迟会让串行总耗时被延迟放大数倍。
- `DelayResolved` 必须在调用 `ResolveExecutionDelay` **之前**无条件置为 true，保证一次请求只判定一次延迟，否则重新入队会无限循环。
- 「多实例检查 + 登记运行中」必须在**同一把写锁**内完成。分成 RLock 检查 + Lock 登记两段会产生 TOCTOU：两个 worker 可同时通过检查，把 `AllowMultipleInstances=false` 的任务跑成两份。
- **准备阶段必须有 `recover`**：`executeTask` 内 `OnTaskScheduled` / `OnTaskExecuting` / `OnTaskStarted` 的 panic 会打穿 worker goroutine，那个并发名额将永久消失。`runTask` 内部自带 recover，但覆盖不到它之外的阶段。
- **关停顺序固定**：`SignalStop()` → `StopAllRunningTasks()` → `WaitWorkers()` → `executor.Wait()`。先等 worker 再杀进程会让每次关机都白等满超时。
- 队列容量与并发数解耦。`Enqueue` 保持非阻塞 + 满时返回错误的语义，**不得**改成阻塞入队（会卡死 cron 线程）。
- 任何入队失败路径都必须保证任务状态不停留在 `queued` 假象上——包括 `EnqueueDelayed` 到期后重新入队失败这条新路径。
- **并发数改动必须热生效**：保存 `max_concurrent_tasks` 后立刻走 `reloadRuntimeConfigKeys` -> `ApplySchedulerWorkerCount()`，不得要求用户重启面板（重启会中断所有正在运行的任务）。
- **调小只能在两次任务之间收 worker**：退休判断必须放在 worker 取下一个请求**之前**，绝不能打断正在执行的任务。因此调小是最终一致的，测试必须轮询断言，不能用固定 sleep。
- **「超编就退休」必须在同一把锁内判断 + 减计数**：`desiredWorkers` / `liveWorkers` 刻意用普通 int + `workerLock`，不用 atomic。atomic 会让这个 check-then-act 出现多个 worker 同时判定自己该退出，最终退得比该退的多。
- **调小必须唤醒空闲 worker**：空闲 worker 阻塞在 `taskQueue` 上，不通过 `resizeCh` 叫醒就发现不了自己已经超编；队列长期空闲时调小会完全不生效。唤醒信号必须非阻塞发送，且 worker 回到循环顶部要重新判断（不能信任信号本身），这样并发数被连续改动时也能自愈。

### 4. Validation & Error Matrix

- 同一任务已在执行 + `AllowMultipleInstances == false` -> `acquireRunningSlot` 返回 false，本次触发被丢弃，日志必须说明是**单实例规则**而非并发上限（并发上限只排队不丢弃，写错会误导用户排查方向）。
- `AllowMultipleInstances == true` -> 不受单实例限制，但仍受 `WorkerCount` 约束。
- `ResolveExecutionDelay > 0` 且 `DelayResolved == false` -> 交给 `EnqueueDelayed`，worker `continue` 取下一个请求，**不占槽位**。
- `DelayResolved == true` -> 直接执行，不再二次延迟。
- 延迟等待期间调度器关停 -> `EnqueueDelayed` 走 `stopCh` 分支直接放弃，由 `MarkActiveTasksInterrupted` 兜底结算。
- 延迟到期重新入队失败（队列满）-> 打日志 + 把仍停在 `queued` 的任务状态放回 `ResolveTaskInactiveStatus(task)`。
- 准备阶段 panic -> `recover` 后按 `OnTaskFailed` 结算，槽位由 `defer removeRunningTask` 正常归还。
- `handler == nil`（测试场景）-> `deferForExecutionDelay` 与 `executeTask` 都必须有判空保护，不得空指针。

### 5. Good/Base/Bad Cases

- Good：并发数设为 1 时开机任务严格串行，用户把前置任务排到 `sort_order` 第一位即可完成编排，不必把前置脚本复制进每个任务。
- Base：并发数设为 5（默认），6 个任务同时触发时 5 个执行、1 个排队，无任务丢失。
- Bad：`OnTaskExecuting` 里 `go runTask(...)` 后立即返回——闸门只覆盖派发窗口，`max_concurrent_tasks` 与「不允许多实例」双双失效，且**静默无报错**。
- Bad：把随机延迟的 `time.Sleep` 留在 worker 线程上——延迟直接吃掉并发名额。
- Bad：`WorkerCount` 只在 `InitSchedulerV2()` 读一次，改配置后必须重启面板才生效。用户升级后把并发数改成 1、保存成功却毫无效果，只会得出「还是没修好」的结论，而重启面板又会中断所有正在运行的任务。
- Bad：调小并发数时直接 kill 掉多余 worker，或让 worker 在执行任务途中退出——正在跑的任务会被无声打断。

### 6. Tests Required

见 `server/service/scheduler_v2_concurrency_test.go`，用假 handler 实现完整接口，不落库、不跑真实脚本：

- 并发数 1 -> 后一个任务的 `Start` 不早于前一个任务的 `End`，且峰值并发 == 1。
- 并发数 2 + 4 个任务 -> 峰值并发 `<= 2`，同时断言峰值**确实达到** 2（否则用例可能在空转）。
- `AllowMultipleInstances=false` 执行中重复触发 -> 第二次被拒绝，`startedCount == 1`。
- `AllowMultipleInstances=true` -> 可并行，峰值 == 2。
- 开机任务在并发数 1 下按 `sort_order` 升序执行，且区间不重叠。
- 执行中 `GetRunningCount() == 1`，结束后 == 0。
- 有延迟时 worker 不占槽位（延迟期间其他任务可正常执行）。
- 准备失败 / 准备阶段 panic -> 槽位都必须归还，且后续任务仍能被同一个 worker 执行。
- 延迟重新入队失败 -> 任务状态从 `queued` 回落。
- `ShutdownSchedulerV2` 在有任务运行时耗时远小于等待超时，且中断发生在等待 worker 之前。
- `SetWorkerCount` 调大 -> 排队中的任务立刻被新 worker 接走，峰值达到新上限。
- `SetWorkerCount` 调小 -> 收缩完成后峰值不超过新上限。
- `SetWorkerCount` 调小时队列全程空闲 -> `GetWorkerCount()` 仍必须降到目标值（这条专门防「空闲 worker 卡在 `<-taskQueue` 上永远发现不了自己该退休」）。
- `SetWorkerCount` 调小时有任务在执行 -> 该任务必须正常跑完。
- `SetWorkerCount(0)` / 负数 -> 钳到 1，调度器仍能执行任务。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestSchedulerV2|TestShutdownSchedulerV2|TestTaskExecutorResolveExecutionDelay|TestShouldApplyRandomDelayForTrigger" -count=3
go test ./...
```

> **突变验证**：这类闸门用例极易写成「永远为真」。把 `s.handler.RunTask(req)` 临时改成 `go s.handler.RunTask(req)`（等价于回到 bug 前的非阻塞行为），串行、并发上限、单实例、开机顺序、运行计数五条用例必须**确定性变红**；若不红，说明用例没有真正在检测闸门。

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：派发完就返回，defer 立刻释放槽位。
// max_concurrent_tasks 和 AllowMultipleInstances 双双失效，且没有任何报错。
func (s *SchedulerV2) executeTask(req *ExecutionRequest) {
	s.addRunningTask(req.TaskID, goid)
	defer s.removeRunningTask(req.TaskID, goid)   // ← 任务还在跑就被摘掉
	s.handler.OnTaskExecuting(req)                 // ← 内部 go runTask(...) 后立即返回
}
```

```go
// 错误：随机延迟在 worker 线程上 sleep，直接空占一个并发名额。
if shouldApplyRandomDelayForTrigger(req.TriggerType) {
	time.Sleep(time.Duration(rand.Intn(randomDelay)+1) * time.Second)
}
```

```go
// 错误：两段锁之间存在 TOCTOU，两个 worker 可同时通过单实例检查。
if !s.checkConcurrency(req) { return }   // RLock
s.addRunningTask(req.TaskID, goid)       // Lock
```

#### Correct

```go
// 正确：槽位持有到任务真正结束；准备与执行分离；准备阶段 panic 不吃掉名额。
func (s *SchedulerV2) executeTask(req *ExecutionRequest) {
	goid, ok := s.acquireRunningSlot(req)   // 检查 + 登记在同一把写锁内
	if !ok {
		return
	}
	defer s.removeRunningTask(req.TaskID, goid)
	defer func() {
		if r := recover(); r != nil {
			s.handler.OnTaskFailed(req, fmt.Errorf("任务调度阶段异常: %v", r))
		}
	}()

	if err := s.handler.OnTaskExecuting(req); err != nil {   // 只准备
		s.handler.OnTaskFailed(req, err)
		return
	}
	s.handler.OnTaskStarted(req)
	s.handler.RunTask(req)                                    // 阻塞到结束
}
```

```go
// 正确：延迟在取槽位之前完成，worker 立刻去处理下一个请求。
if s.deferForExecutionDelay(req) {
	continue
}
s.executeTask(req)
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

## 场景：任务自定义成功退出码

### 1. Scope / Trigger

- 触发：修改 `model.Task` 的退出码字段、`task_executor.go` / `scheduler.go` 的成功判断、任务日志结算、重试、通知，或任务创建/编辑/复制/导入导出时必须看本节。
- 原因：少量历史脚本会在业务完成后返回 `1`。面板需要允许任务显式兼容，但不能通过“结束”“完成”等日志文本猜测成功，更不能把所有退出码 `1` 全局放行。

### 2. Signatures

- 任务字段：`Task.SuccessExitCodes string`
- API / 导入导出字段：`success_exit_codes`，字符串，例如 `"0,1"`
- 数据库字段：`tasks.success_exit_codes VARCHAR(128) NOT NULL DEFAULT '0'`
- 规范化：`func NormalizeSuccessExitCodes(raw string) (string, error)`
- 运行判断：`func (t *Task) IsSuccessExitCode(exitCode int) bool`
- 前端入口：任务表单 -> 高级设置 -> 成功退出码

### 3. Contracts

- 默认值、空字符串、`null` 和旧数据都按 `0` 处理，现有任务升级后行为不能改变。
- 只接受 `0-255` 的整数；允许英文逗号、中文逗号或空白分隔，保存前统一为英文逗号并去重。
- 只有 `RunCommandWithPlan` 正常返回进程结果后，才允许调用 `IsSuccessExitCode`。
- 启动错误、执行器 panic、超时/信号负退出码不能被配置覆盖；主动停止继续由 `applyManualStopOverride` 结算为 Aborted。
- `TaskExecutor` 和旧 `Scheduler` 必须使用同一规则；重试、任务状态、日志状态、依赖任务、统计和通知不能分叉。
- `TaskExecutor` 的任务状态和日志状态都必须使用同一个 `success` 结果，禁止日志状态再次直接判断 `exitCode != 0`。
- 非零成功码仍保留真实退出码，日志尾部追加“已按任务配置判定成功”，便于用户区分标准成功和兼容成功。
- 新字段必须同步：model、`EnsureColumns()`、创建/更新 handler、`ToDict()`、复制、导入导出和任务表单。

### 4. Validation & Error Matrix

- 默认/空配置 + 退出码 `0` -> Success。
- 默认/空配置 + 退出码 `1` -> Failed，按原规则重试和通知。
- 配置 `0,1` + 退出码 `1` -> Success，不发送失败通知，日志保留退出码 `1` 和兼容说明。
- 配置 `0,1` + 退出码 `2` -> Failed。
- 任意配置 + 退出码 `-1`（超时或信号）-> Failed。
- 任意配置 + 进程启动错误 / 执行器 panic -> Failed，不能因为错误路径使用了内部值 `1` 而成功。
- 任意配置 + 手动停止 / 定时停止 -> Aborted，不进入成功或失败通知。
- 配置含文本、负数或大于 `255` -> API 返回参数错误，导入时跳过该任务并记录错误。

### 5. Good/Base/Bad Cases

- Good：确认某历史脚本业务完成后固定 `process.exit(1)`，仅给该任务配置 `0,1`；任务、日志和通知都显示成功，日志仍能看到真实退出码。
- Base：普通脚本不改设置，退出 `0` 成功、退出非零失败。
- Bad：看到日志最后有“结束”就全局把退出码 `1` 改成成功，真实异常也会被隐藏。
- Bad：任务状态按 `success` 写成功，但日志状态继续按 `exitCode != 0` 写失败，造成列表、统计和通知互相矛盾。

### 6. Tests Required

- model：空值默认 `0`；`0,1` 接受 `1`、拒绝 `2`；负数永不成功；非法文本和范围返回错误。
- database：模拟旧库缺列，`EnsureColumns()` 必须补出 `success_exit_codes`，已有任务默认回填 `0`。
- handler：创建、更新、复制、导出和导入能保存规范化字段；非法配置返回 `400` 或导入错误。
- executor：同一个真实退出码 `1` 在默认配置下任务/日志均失败，在 `0,1` 下任务/日志均成功，并保留退出码和兼容说明。
- notification：非零成功码必须生成 Success 标题/context，保留真实 `exit_code`，且失败原因字段为空。
- 修改后至少运行：

```bash
cd server
go test ./model ./handler ./service -run "TestNormalizeSuccessExitCodes|TestTaskIsSuccessExitCode|TestTaskSuccessExitCodes|TestTaskExecutorAppliesConfiguredSuccessExitCodes" -count=1
go test ./... -count=1
go vet ./...
cd ../web && npm run build
```

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：全局放行 1 会隐藏真正的脚本失败。
if result.ReturnCode == 0 || result.ReturnCode == 1 {
    success = true
}

// 错误：任务成功但日志仍按非零退出码写失败。
if exitCode != 0 {
    logStatus = model.LogStatusFailed
}
```

#### Correct

```go
// 正确：只有正常拿到进程结果后，才按当前任务显式配置判断。
if task.IsSuccessExitCode(result.ReturnCode) {
    success = true
}

// 正确：任务、日志、通知统一使用同一份 success 结果。
if !success {
    logStatus = model.LogStatusFailed
}
```

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

### 8. CommonJS 兼容版本映射

- `NewNpmInstallCommand(packageName)` 内部必须先走 `ResolveNodeInstallPackageSpec(packageName)`，不要直接把裸包名交给 `npm install`。
- 只有裸包名允许命中 CommonJS 兼容映射；用户显式写 `uuid@9.0.0`、`uuid@latest`、Git URL、本地路径、`file:` 等来源时必须保持原样。
- 安装前日志必须调用 `NodeInstallCompatibilityNotice(packageName)`：
  - 命中映射 -> 说明将安装的兼容版本，例如 `uuid@8.3.2`
  - 未命中映射 -> 明确提示“该包未在兼容映射中，将按 npm 默认版本安装。”
- 脚本运行日志命中 `ERR_REQUIRE_ESM` 时，`BuildModuleCompatibilityHint(output)` 应尝试从 `node_modules/<pkg>/...` 或 `require('<pkg>')` 解析包名；命中映射时给出重装旧版建议，未命中映射时提示手动指定兼容 `require()` 的旧版本。

---

## 场景：任务命令支持依赖可执行命令

### 1. Scope / Trigger

- 触发：修改 `server/service/script_runner.go`、`server/service/runtime_exec.go`、任务命令解析、`RunCommand()`、`ParseCommandExecutionPlan()` 或依赖命令执行相关逻辑时必须看本节。
- 原因：部分青龙生态工具（例如 `dailycheckin`）安装后暴露的是 Python/Node 依赖目录里的可执行命令，不一定是 `scripts/` 目录中的 `.py/.js/.sh` 文件。如果只按脚本路径校验，会误报“脚本不存在或命令格式无效”。

### 2. Signatures

- 命令解析入口：`ParseCommandExecutionPlan(command, scriptsDir string) (*CommandExecutionPlan, error)`
- 命令执行入口：`RunCommand(command, scriptsDir string, timeout int, envVars map[string]string, maxOutputBytes int, onOutput OnOutputFunc) (...)`
- 计划字段：
  - `CommandExecutionPlan.ManagedCommand string`
  - `CommandExecutionPlan.PythonModule string`
  - `CommandExecutionPlan.WorkDir string`
- 执行构造：
  - `createManagedExecutableCommand(commandName string, commandArgs []string, workDir string, envVars map[string]string)`
  - `createManagedPythonModuleCommand(interpreter string, moduleName string, moduleArgs []string, workDir string, envVars map[string]string)`

### 3. Contracts

- `dailycheckin --help` 这类裸命令允许作为托管依赖命令执行，但命令名只能包含字母、数字、`_`、`-`、`.`，不能包含路径分隔符、shell 元字符或以 `-` 开头。
- `task dailycheckin now`、`task dailycheckin -- --config config.json` 必须保留 `task` 模式语义和透传参数。
- `python3 -m dailycheckin --help` 必须作为 Python 模块命令执行，模块名只允许字母、数字、`_`、`.`，不能以 `.` 开头/结尾，也不能包含 `..`。
- 托管依赖命令的工作目录默认使用 `scriptsDir`；脚本文件任务继续使用脚本所在目录。
- 托管依赖命令仍要注入任务环境变量，并优先从面板托管 Python/Node bin 目录解析可执行文件，不应直接依赖系统 PATH。

### 4. Validation & Error Matrix

- 命令为空 -> `命令格式无效`
- `task` 后缺少脚本路径或依赖命令名 -> `命令格式无效，缺少脚本路径或依赖命令名`
- 依赖命令名包含非法字符或像文件路径 -> `脚本不存在或命令格式无效`
- `python -m` 缺少模块名 -> `python -m 命令缺少模块名`
- Python 模块名非法 -> `python 模块名无效: <name>`
- 托管 bin 目录找不到命令 -> 提示先安装对应 Python/Node 依赖，或改用脚本文件命令

### 5. Good/Base/Bad Cases

- Good：用户在依赖页安装 `dailycheckin` 后，任务命令填写 `dailycheckin --help` 可以直接运行。
- Base：传统脚本路径命令 `task demo.py now`、`node demo.js`、`bash demo.sh` 行为不变。
- Bad：把任意包含 `/`、`;`、`&`、`|` 的字符串当依赖命令执行，会绕过脚本路径安全校验并扩大命令注入风险。

### 6. Tests Required

- `TestParseCommandExecutionPlanSupportsManagedDependencyCommands`
  - 断言裸依赖命令、`task` 模式、透传参数、`python -m` 都能解析到正确字段。
- `TestRunCommandSupportsManagedDependencyCommand`
  - 断言依赖命令可以从托管 bin 目录运行，并能读取任务环境变量和参数。
- 回归验证：
  - `cd server && go test ./service -run "TestParseCommandExecutionPlanSupportsManagedDependencyCommands|TestRunCommandSupportsManagedDependencyCommand" -count=1`
  - `cd server && go test ./...`

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：找不到 scriptsDir 下的文件就直接失败，导致 dailycheckin 这类依赖命令无法运行。
fullPath, _, err := findTaskScriptTarget(tokens, scriptsDir, forcedMode)
if err != nil {
    return nil, err
}
```

#### Correct

```go
// 正确：脚本路径查找失败后，再判断是否是安全的托管依赖命令。
fullPath, _, err := findTaskScriptTarget(tokens, scriptsDir, forcedMode)
if err != nil {
    managedCommand, _, managedErr := findTaskManagedCommandTarget(tokens, forcedMode)
    if managedErr != nil {
        return nil, err
    }
    plan.ManagedCommand = managedCommand
    plan.WorkDir = scriptsDir
    return plan, nil
}
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

## 场景：Docker 镜像档位、Python 运行时与更新托管

### 1. Scope / Trigger

- 触发：修改 Dockerfile、Python 安装脚本、发布矩阵、Compose / Watchtower 配置、面板更新 API / CLI，或任务 Python 版本选择逻辑时必须看本节。
- 原因：镜像标签同时决定基础系统、Python 小版本、工具档位和更新方式。任一层漂移都会造成标签与实际内容不符、重复 Python、旧标签断更，或页面显示更新成功但容器没有被选中。

### 2. Signatures

- 构建参数：`PYTHON_RUNTIME_MODE=single|all`
- 构建参数：`PYTHON_RUNTIME_VERSION=3.10|3.11|3.12`
- 工具档位：`INSTALL_FULL_TOOLS=true|false`
- 运行时环境：`DAIDAI_PYTHON_RUNTIME_MODE`、`DAIDAI_PYTHON_VERSION`
- Compose 环境：`DAIDAI_PANEL_IMAGE` -> `image` + `IMAGE_NAME`
- 更新管理环境：`PANEL_UPDATE_MANAGER=watchtower`、`WATCHTOWER_HTTP_API_URL`、`WATCHTOWER_HTTP_API_TOKEN`
- Watchtower 调用：`POST /v1/update?async=true&container=<锚定且转义的容器名>`
- 更新状态：`idle|running|restarting|completed|failed`，Watchtower 接管终态为 `completed / watchtower-triggered`
- 当前镜像版本列表：`CurrentPythonRuntimeVersions() []string`
- 单版本识别：`SinglePythonRuntimeVersion() (string, bool)`
- 启动策略修正：`ApplySinglePythonRuntimePolicyOnStartup()`
- 启动目录清理：`CleanupManagedPythonArtifactsOnStartup()`

### 3. Contracts

- 正式浮动标签固定为 10 个：`latest`、`latest-full`、`latest-3.10`、`latest-3.11`、`latest-all`、`debian`、`debian-full`、`debian-3.10`、`debian-3.11`、`debian-all`。
- `latest` / `debian` 默认使用 `PYTHON_RUNTIME_MODE=single` 和 `PYTHON_RUNTIME_VERSION=3.12`，只内置 Python `3.12`。
- `latest-3.10`、`latest-3.11`、`debian-3.10`、`debian-3.11` 分别只内置对应 Python 小版本；`latest-all`、`debian-all` 同时安装 `3.10 / 3.11 / 3.12`。
- `latest-full` 与 `debian-full` 仍只保留一套 Python 3.12；`INSTALL_FULL_TOOLS=true` 只增加 Go、Docker CLI、wget 和原生编译工具，不能重新引入发行版 Python。
- Alpine 的 `latest-3.10`、`latest-3.11`、`latest-all` 只发布 `amd64 / arm64`；如果某个平台没有 python-build-standalone 资产，脚本必须失败而不是回退成错误版本。默认 `latest` / `latest-full` 可以在 32 位平台使用经过小版本校验的发行版 Python 3.12。
- Debian 所有变体和 Alpine 64 位变体只使用 `/opt/daidai-python` 独立运行时；all 镜像只能有三套目标 Python，不能再附带系统 Python。
- 六个旧无连字符浮动标签和 Debian 旧固定版本格式必须与新标签由同一个 build-push 矩阵项推送，不能增加重复构建任务。
- 精简镜像的页面手动更新、静默自动更新和 `ddp update` 统一调用 Watchtower HTTP API；请求必须使用 `async=true` 并精确限定当前容器，202 纯文本响应也属于“已接管”成功态。
- Watchtower 只能刷新容器当前镜像引用。官方固定版本标签和 digest 必须禁用一键/自动更新并提示切换到同族浮动标签，不能把“请求已接管”误报成能够跨版本升级。
- Compose 的实际 `image` 与容器内 `IMAGE_NAME` 必须共用 `DAIDAI_PANEL_IMAGE`；Watchtower API 地址使用稳定服务名 `http://watchtower:8080`。
- 单版本镜像启动后，后端 `SupportedPythonVersions()` / 依赖安装版本 / 任务表单选项必须只暴露当前镜像小版本。
- 单版本镜像启动后，必须把 `python_default_version` 和历史任务 `python_version` 切回当前镜像小版本；默认 `latest` / `debian` 即 `3.12`。
- 单版本镜像启动清理只能删除 `data/deps/python/<不支持版本>` 这类面板托管 Python 小版本目录，不能删除脚本、日志、备份、Node.js 依赖或未知目录。
- `all` 镜像不得清理 `3.10 / 3.11 / 3.12` 任意一个托管目录。

### 4. Validation & Error Matrix

- `PYTHON_RUNTIME_MODE` 不是 `single|all` -> 构建失败，不得回退到 single。
- `PYTHON_RUNTIME_VERSION` 不是 `3.10|3.11|3.12` -> 构建失败，不得回退到 3.12。
- 独立 Python patch 版本、pip 或 venv 校验失败 -> 构建失败，不得发布该标签。
- 64 位或 Debian 镜像检测到系统 `python3` -> 构建失败，防止双 Python 回归。
- 精简镜像检测到 Go、gofmt、Docker CLI、wget 或编译链 -> 构建失败。
- Watchtower 缺 URL / token -> 禁用手动触发并给出缺失配置提示；定时轮询状态仍可展示。
- 官方固定版本标签或 digest 使用 Watchtower -> 禁用一键 / 自动更新，提示切换到同族浮动标签。
- 旧 Docker Socket 链目标不是 `latest-full|debian-full` -> 拉取前失败并提示改用 Watchtower 或 full 镜像。
- Watchtower 返回 202 纯文本 `Accepted` -> 记录为“已接管”，不能宣称镜像已完成更新；4xx / 5xx -> 进入 failed 并允许重试。

### 5. Good/Base/Bad Cases

- Good：`debian-full` 只有独立 Python 3.12，同时具备 Go、gofmt、Docker CLI、wget 和编译链；页面触发后显示 Watchtower 已接管。
- Base：`latest` 在 amd64 只有独立 Python 3.12 和精简工具；Alpine 386 / arm/v7 使用经过版本校验的单套系统 Python 3.12。
- Bad：给 `debian-all` 再安装系统 Python，或把 `debian-full` 更新目标静默改成 `latest`。
- Bad：Watchtower 请求同时使用容器名和可能过期的 `IMAGE_NAME` 过滤，收到 202 后实际零匹配。

### 6. Tests Required

- `SupportedPythonVersions()` 在 `DAIDAI_PYTHON_RUNTIME_MODE=single` 时只返回当前版本。
- `CleanupManagedPythonArtifactsOnStartup()` 在 single `3.12` 时删除 `3.10 / 3.11` 目录并保留 `3.12`。
- `CleanupManagedPythonArtifactsOnStartup()` 在 `all` 时保留三个版本目录。
- `ApplySinglePythonRuntimePolicyOnStartup()` 必须把旧默认版本和旧任务版本切回镜像版本。
- Python 依赖创建在 single 镜像里只创建当前小版本依赖记录。
- 发布 workflow 必须逐 job 验证 10 个正式标签、6 个旧浮动别名、3 个 Debian 旧固定别名及同一次 build-push 输出。
- `latest-full`、`debian-full` 的 Docker Socket 兼容边界，以及精简 / 自定义固定标签的拒绝行为必须有表格测试。
- Watchtower 请求必须断言只有 `async=true` 和锚定容器过滤；故意设置 stale `IMAGE_NAME` 时不得生成 image 过滤。
- 前端必须识别 `completed`，停止轮询、解除 loading，并允许关闭“Watchtower 已接管”弹窗。
- 三份 Compose 必须通过 `docker compose config`，且展开后 `image == IMAGE_NAME`、面板 / Watchtower token 一致、Socket 只挂给 Watchtower。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestSupportedPythonVersions|TestCleanupManagedPythonArtifactsOnStartup|TestApplySinglePythonRuntimePolicy" -count=1
go test ./handler -run "TestPythonDependencyCreate" -count=1
```

### 7. Wrong vs Correct

#### Wrong

```text
full_tools=true -> 安装系统 Python + 独立 Python
Watchtower -> /v1/update?image=<可能过期的 IMAGE_NAME>
固定标签 2.4.0-debian-full -> 显示可自动升级到后续版本
```

#### Correct

```text
full_tools=true -> 只增加开发工具，Python 仍只有目标运行时
Watchtower -> /v1/update?async=true&container=^daidai-panel$
固定标签 / digest -> 明确提示先切换到 debian-full 等同族浮动标签
```

---

## 场景：auto_update_last_checked_at 配置键注册

### 1. Scope / Trigger

- 触发：修改系统设置概览、更新检查时间展示、`configApi.get('auto_update_last_checked_at')` 相关逻辑时必须看本节。
- 原因：前端会读取 `auto_update_last_checked_at`。如果后端未把它注册成正式配置键，`/api/configs/auto_update_last_checked_at` 会返回 404，页面虽然能兜底，但运行态会持续报错。

### 2. Signatures

- 前端读取：`configApi.get('auto_update_last_checked_at')`
- 后端注册：`newTrimmedStringConfig("auto_update_last_checked_at", "上次检查更新时间", "", "...", "network")`
  （参数顺序：`key, label, defaultValue, description, group`）

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
newBoolConfig("auto_update_enabled", "静默更新", "false", "...", "network")
// 忘记注册 auto_update_last_checked_at
```

#### Correct

```go
newBoolConfig("auto_update_enabled", "静默更新", "false", "...", "network")
newTrimmedStringConfig("auto_update_last_checked_at", "上次检查更新时间", "", "上次自动检查更新时间", "network")
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

## 场景：面板全局时区配置

### 1. Scope / Trigger

- 触发：修改面板日志时间、任务调度日期判断、任务运行环境、系统设置配置项或 Linux 二进制发行包启动行为时必须看本节。
- 原因：裸 Linux 二进制运行环境可能没有 `TZ`，`/etc/localtime` 也可能缺失或指向 UTC。只改某一处时间格式不能解决问题，必须统一处理 Go 进程本地时区和脚本子进程 `TZ`。

### 2. Signatures

- 配置键：`model.PanelTimezoneConfigKey = "timezone"`
- 默认值：`model.DefaultPanelTimezone = "Asia/Shanghai"`
- 后端应用：`service.ApplyPanelTimezone(value string) error`
- 启动应用：`service.ApplyRegisteredPanelTimezone() error`
- 当前运行时读取：`service.CurrentPanelTimezone() string`
- 任务环境构造：`service.BuildManagedRuntimeEnvMapForPythonVersion(...)`
- 前端字段：`SettingsConfigForm.timezone`

### 3. Contracts

- `timezone` 必须注册到系统配置表，默认值为 `Asia/Shanghai`。
- 后端必须使用 `time.LoadLocation` 校验时区名，并内嵌 Go `time/tzdata`，不能依赖宿主机一定安装 tzdata。
- 面板启动时必须在 `model.InitDefaultConfigs()` 之后调用 `ApplyRegisteredPanelTimezone()`，因为要读取默认配置或用户已保存配置。
- 应用时区必须同时设置：
  - `time.Local`
  - 进程环境变量 `TZ`
  - 内部当前面板时区缓存
- 保存 `timezone` 配置后必须立即重载运行时，不要求用户重启面板。
- 任务运行环境必须写入 `envMap["TZ"] = CurrentPanelTimezone()`，并覆盖用户普通环境变量里同名 `TZ`，保证面板日志和脚本时间一致。
- Windows Python 的 CRT 不能正确解析 `Asia/Shanghai` 等 IANA 名称。只有 Python 脚本和 Python 模块的**启动环境**需要按任务启动时的当前偏移转换为 POSIX 固定偏移；Node.js 和其他运行时继续使用 IANA 名称。
- Windows CRT 的 POSIX 时区缩写必须是三个 ASCII 字母，且偏移符号与 UTC 偏移相反，例如 UTC+8 写成 `CST-8`、UTC-4 写成 `EDT4`、UTC+5:30 写成 `IST-5:30`。无法生成三字母缩写时使用稳定的 `DDT`。
- Windows Python 会延迟解析 `TZ`。bootstrap 必须在 env.json 恢复 IANA 名称前调用一次 `time.localtime()` 初始化本地时区；脚本最终读取 `os.environ["TZ"]` 时仍应得到用户设置的 IANA 名称。
- 有夏令时的地区在每次 Python 任务启动时重新计算当前偏移。长驻 Python 任务跨越夏令时切换点后需要重启任务，才能使用新偏移。
- 前端系统设置页必须提供可见入口，并把 `timezone` 纳入同一组保存键。

### 4. Validation & Error Matrix

- `timezone` 缺失或空值 -> 使用 `Asia/Shanghai`
- `timezone=Asia/Tokyo` / `UTC` -> 保存成功，并立即影响 `time.Local` 和后续任务 `TZ`
- `timezone=Bad/Zone` -> 保存失败，返回用户可读错误
- `timezone=Local` -> 保存失败，要求填写明确 IANA 时区，避免不同宿主环境表现不一致
- 用户环境变量表里也配置了 `TZ=UTC` -> 任务最终仍使用面板全局时区
- Windows Python + `Asia/Shanghai` -> 启动环境使用 `CST-8`，脚本本地时间为 `+08:00`，脚本读取 `TZ` 仍为 `Asia/Shanghai`
- Windows Node.js + `Asia/Shanghai` -> 启动环境保持 IANA 名称，本地时间仍为 `GMT+0800`
- Linux / Docker / 面具版 Python -> 启动环境保持 IANA 名称，不转换为固定偏移

### 5. Good/Base/Bad Cases

- Good：Linux tar 包直接启动，宿主机没有设置 `TZ`，面板仍按 `Asia/Shanghai` 写日志，脚本也拿到 `TZ=Asia/Shanghai`。
- Good：Windows Python 以 `CST-8` 初始化本地时间后，bootstrap 把脚本可见的 `TZ` 恢复为 `Asia/Shanghai`，时间和配置语义同时正确。
- Base：Docker 用户原本设置 `TZ=Asia/Shanghai`，升级后系统设置同样默认 `Asia/Shanghai`，行为不变。
- Bad：只在前端显示时加 8 小时，后端日志和任务脚本仍按 UTC 运行，定时任务日期判断继续错。
- Bad：把所有运行时的 `TZ` 都改成 `CST-8`；Windows Node.js 会把它解释成 UTC，Linux 也会失去 IANA 夏令时规则。
- Bad：Windows Python 启动后立刻恢复 `Asia/Shanghai`，却没有先调用 `time.localtime()`；Python 第一次取本地时间时仍会错误解析成 `+01:00`。

### 6. Tests Required

- 默认配置：`GetRegisteredConfig("timezone") == "Asia/Shanghai"`
- 校验：有效 IANA 时区可保存，无效时区和 `Local` 被拒绝。
- 运行时应用：`ApplyPanelTimezone("UTC")` 后 `time.Local.String()=="UTC"` 且 `os.Getenv("TZ")=="UTC"`。
- 保存立即生效：通过配置接口保存 `timezone` 后，`CurrentPanelTimezone()` 立即变为新值。
- 任务环境：`BuildManagedRuntimeEnvMapForPythonVersion` 返回的 `TZ` 必须等于当前面板时区，并覆盖用户环境变量表里的同名 `TZ`。
- 偏移转换：覆盖 UTC、正负偏移、分钟偏移、夏令时和四字母缩写，确认生成 Windows CRT 可识别的三字母 POSIX 值。
- Windows 真实进程：Python 脚本和 Python 模块均输出 `+08:00` 且读取到 `TZ=Asia/Shanghai`；Node.js 仍输出 `GMT+0800`。

### 7. Wrong vs Correct

#### Wrong
```go
// 错误：只设置子进程环境，Go 进程自己的 time.Now() 仍可能按 UTC。
envMap["TZ"] = "Asia/Shanghai"
```

```go
// 错误：依赖宿主机 Local，精简 Linux 上可能仍是 UTC。
time.Now().Format("2006-01-02 15:04:05")
```

#### Correct
```go
if err := service.ApplyRegisteredPanelTimezone(); err != nil {
    return fmt.Errorf("failed to apply panel timezone: %w", err)
}
```

```go
// 正确：任务环境强制跟随面板全局时区，避免脚本时间和面板日志不一致。
envMap["TZ"] = service.CurrentPanelTimezone()
```

```go
// 正确：只给 Windows Python 的启动环境转换格式，不能修改原任务变量或 Node 环境。
cmd.Env = buildPythonBootstrapProcessEnv(envVars)
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

---

## 场景：Node preload 兼容青龙脚本的 `process.env` 字符串检测

### 1. Scope / Trigger

- 触发：修改 `server/service/runtime_exec.go` 里 Node / TypeScript 托管运行时、`writeNodePreloadScript`、环境变量注入、`NODE_OPTIONS` / preload 相关逻辑时必须看本节。
- 原因：少数青龙脚本会执行 `JSON.stringify(process.env).indexOf("GITHUB")`，只要任务环境变量的 key 或 value 包含大写 `GITHUB` 就 `process.exit(0)` 静默退出，表现为日志只有“开始”，退出码却是 0。

### 2. Signatures

- Node preload 生成入口：`writeNodePreloadScript(tempDir, envFile string, envVars map[string]string) (string, error)`
- Node 命令入口：`createManagedNodeCommand(...)`
- TypeScript Node 命令入口：`createManagedTSNodeCommand(...)`
- 环境文件：`env.json`，由 preload 读入并写入 `process.env`

### 3. Contracts

- preload 必须继续把 `env.json` 中的任务环境变量写入真实 `process.env`，不能删除用户显式配置的 `GITHUB_*` 变量。
- 仅对 `JSON.stringify(process.env)` 做兼容过滤：返回的 JSON 字符串中不应包含 key 或 value 带大写 `GITHUB` 的环境项。
- `process.env.GITHUB_*` 直接读取必须仍然可用，避免破坏确实依赖 GitHub 变量的脚本。
- 普通 `JSON.stringify({ GITHUB_ACTIONS: 1 })` 等非 `process.env` 对象必须保持 Node 原生行为。

### 4. Validation & Error Matrix

- `env.json` 包含 `GITHUB_ACTIONS=1` -> `JSON.stringify(process.env)` 不包含 `GITHUB`，但 `process.env.GITHUB_ACTIONS === "1"`。
- `env.json` 不含 `GITHUB` -> 普通环境注入和脚本执行行为不变。
- 用户脚本 stringify 普通对象 -> 不过滤、不改写。
- 如果删除真实 `process.env.GITHUB_*` -> 错误，会破坏显式读取变量的脚本。

### 5. Good/Base/Bad Cases

- Good：`hex-ci/smzdm_script` 这类脚本不再因为环境里有 `GITHUB` 而静默成功退出，后续签到日志能继续输出。
- Base：普通 Node 脚本继续通过 `process.env.SMZDM_COOKIE`、`process.env.NODE_PATH` 等读取任务环境。
- Bad：直接清理所有 `GITHUB_*` 环境变量，导致需要 GitHub token 或仓库信息的脚本读取不到配置。

### 6. Tests Required

- 回归测试：`TestNodePreloadKeepsGithubEnvReadableButHiddenFromStringify`
  - 断言 `JSON.stringify(process.env)` 不含 `GITHUB`。
  - 断言 `process.env.GITHUB_ACTIONS` 仍可直接读取。
  - 断言普通任务环境变量仍可直接读取。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestNodePreloadKeepsGithubEnvReadableButHiddenFromStringify|TestBuildManagedRuntimeEnvMap" -count=1
go test ./...
```

### 7. Wrong vs Correct

#### Wrong

```js
// 错误：删除真实变量会破坏用户脚本显式读取 GITHUB_TOKEN / GITHUB_ACTIONS 的场景。
delete process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_TOKEN;
```

#### Correct

```js
// 正确：只兼容 JSON.stringify(process.env) 这种粗暴检测，不删除真实 process.env。
const originalJSONStringify = JSON.stringify;
JSON.stringify = function(value, replacer, space) {
  if (value === process.env) {
    const envCopy = {};
    for (const [key, envValue] of Object.entries(process.env)) {
      if (String(key).includes('GITHUB') || String(envValue).includes('GITHUB')) {
        continue;
      }
      envCopy[key] = envValue;
    }
    return originalJSONStringify.call(JSON, envCopy, replacer, space);
  }
  return originalJSONStringify.call(JSON, value, replacer, space);
};
```

---

## 场景：`config.sh` 多行环境变量安全解析

### 1. Scope / Trigger

- 触发：修改 `server/service/runtime_exec.go` 里的 `loadConfigShellVars()`、任务环境合并优先级或配置文件语法时必须看本节。
- 原因：`config.sh` 允许用引号包住多行账号。如果按行独立解析，`process.env`、`os.environ` 和 Shell 任务只能拿到首行；如果直接 `source config.sh`，又会执行用户文件里的任意 Shell 命令。

### 2. Signatures

- 配置读取：`func loadConfigShellVars(envMap map[string]string)`
- 任务环境入口：`BuildManagedRuntimeEnvMapForPythonVersion(...)`
- 配置文件：`filepath.Join(config.C.Data.Dir, "config.sh")`
- Node.js 注入：`env.json -> writeNodePreloadScript() -> process.env`

### 3. Contracts

- 只解析 `KEY=VALUE` 和可选 `export KEY=VALUE`，禁止通过 `source`、`bash -c` 或等价方式执行 `config.sh`。
- 单引号和双引号内的真实跨行内容必须保留 `\n`，不能只记录首行，也不能自动改成 `&` 或字面量 `\\n`。
- 单行值、空值、引号内的 `=` / `#` 继续按原内容读取。
- 同一 `config.sh` 里同名键重复赋值时，后面的合法赋值覆盖前面的赋值。
- 环境变量页面（数据库 `env_vars`）的同名键优先级高于 `config.sh`；面板全局 `TZ` 仍在两者之后强制覆盖。
- 历史上能读取的非空键名不应在这条链路新增强制过滤；不同运行时后续可按自己的环境变量能力过滤。

### 4. Validation & Error Matrix

- `export CK='a\nb\nc'` -> `envMap["CK"] == "a\nb\nc"`。
- `export CK="a=1\nb#2"` -> 保留换行、`=` 和 `#`。
- 引号未闭合且遇到后续合法 `export NEXT=...` -> 忽略损坏项，继续读取 `NEXT`。
- 文件不存在或无法读取 -> 保持原有环境映射，不阻断任务构建。
- 数据库和 `config.sh` 同时存在同名键 -> 使用数据库值。

### 5. Good/Base/Bad Cases

- Good：用户在一个 `export csCk='...'` 里换行填写四个账号，Node.js `process.env.csCk` 读到完整四行。
- Base：`KEY=value`、`export KEY="value"`、注释和空行行为不变。
- Bad：用 `bufio.Scanner` 逐行立即赋值，导致引号跨行值只剩第一行。
- Bad：为复用 Shell 解析直接 `. config.sh`，导致任务构建阶段执行用户命令。

### 6. Tests Required

- `TestLoadConfigShellVarsSupportsMultilineQuotedValues`：断言单引号多行、双引号多行、单行、空值和历史键名。
- `TestLoadConfigShellVarsIgnoresBrokenMultilineAndKeepsFollowingExport`：断言损坏项不入环境，后续合法 `export` 仍可读取。
- `TestBuildManagedRuntimeEnvMapKeepsDatabaseEnvPriorityOverConfigFile`：断言环境变量页面的同名值优先。
- `TestConfigShellMultilineValueReachesNodeProcessEnv`：真实启动 Node.js，断言 `process.env` 收到完整换行值。
- 修改后至少运行：

```bash
cd server
go test ./service -run "TestLoadConfigShellVars|TestBuildManagedRuntimeEnvMapKeepsDatabaseEnvPriorityOverConfigFile|TestConfigShellMultilineValueReachesNodeProcessEnv" -count=1
go test ./...
```

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：第一行立即写入环境，后续没有 '=' 的账号行会被丢弃。
for scanner.Scan() {
    line := strings.TrimSpace(scanner.Text())
    envMap[key] = strings.Trim(value, "\"'")
}
```

#### Correct

```go
// 正确：先收集到同类型闭合引号，完成后再写入配置值。
if closeAt := findClosingQuote(value[1:], quote); closeAt < 0 {
    pendingKey = key
    pendingQuote = quote
    pendingValue.WriteString(value[1:])
}
```

---

## 场景：系统配置注册表默认值与渲染 schema

### 1. Scope / Trigger

- 触发：改动 `server/model/system_config_registry.go` 的 `SystemConfigDefinition`、任意 `newXxxConfig` 构造函数、任意一项配置的默认值或 normalize 函数，以及 `server/handler/config.go` 的 `buildConfigResponseItem` 时必须看本节。
- 原因：`GET /api/configs` 下发的是完整 schema，Web 和 APP 都据此渲染系统设置页。注册表既是服务端的取值来源，也是客户端唯一的界面描述来源，一旦分叉两边都会静默错。

### 2. Signatures

- 声明结构：`model.SystemConfigDefinition`（含 `Label` / `GroupLabel` / `Order` / `Secret` / `Min` / `Max`）
- 构造函数统一参数顺序：`(key, label, defaultValue, description, group, ...)`
  - `newTrimmedStringConfig(key, label, defaultValue, description, group)`
  - `newSecretStringConfig(key, label, defaultValue, description, group)`
  - `newValidatedStringConfig(key, label, defaultValue, description, group, normalize)`
  - `newBoolConfig(key, label, defaultValue, description, group)`
  - `newIntConfig(key, label, defaultValue, description, group, minValue, maxValue)`
  - `newEnumConfig(key, label, defaultValue, description, group, options)`
- 顺序与分组名补齐：`finalizeSystemConfigSpecs(specs []systemConfigSpec) []systemConfigSpec`
- 分组中文名：`systemConfigGroupLabels`
- 按 key 取归一化函数：`model.NormalizeSystemConfigValue(key, value string) (string, error)`

### 3. Contracts

- **声明的默认值必须等于实际生效的默认值**：对每一项配置，`NormalizeSystemConfigValue(key, "")` 必须与 `def.DefaultValue` 完全相等。
  `newValidatedStringConfig` 把 `DefaultValue` 原样存进 definition、注册时不过 normalize，所以这两处一旦各写一份字面量就会静默错开。有共用默认值时应抽成常量（例如 `defaultBackupScheduleSelection`），不要在两处各写一遍。
- 默认值本身必须是合法且已归一化的值：`NormalizeSystemConfigValue(key, def.DefaultValue)` 必须无错且原样返回。
- `Label` 是输入框标题用的短词，必须非空；`Description` 是长句说明，只能当 hint，不得当标题。
- 新增分组 slug 必须同步在 `systemConfigGroupLabels` 补中文名，`GroupLabel` 不允许退化成英文 slug。
- `Order` 由 `finalizeSystemConfigSpecs` 按注册下标写入，必须在 `registeredSystemConfigSpecs` 的初始化表达式里调用，**不能挪到 `init()`**：`registeredSystemConfigMap` 按值拷贝存 spec，`init()` 里再改切片会让 map 拿到旧数据。
- 整数配置必须下发 `Min` / `Max`，且与 normalize 闭包里的校验边界一致；`Min` / `Max` 用局部拷贝取地址，不要直接 `&minValue`，避免调用方改 `*def.Min` 反过来改掉校验行为。
- 凭据类配置必须标 `Secret`，并同步更新 `TestRegisteredSecretConfigsAreMarked` 的名单。
  `Secret` 目前**只是渲染提示**，服务端仍明文回传 `value`。要改成服务端打码，必须同时定义「未修改」的写入哨兵值并同步改 Web/APP，否则保存整组配置时会把掩码写回数据库、覆盖真实密钥。
- `/api/configs` 的响应字段只允许新增，不允许改名或改类型：老客户端拿到多出来的键必须无感。

### 4. Validation & Error Matrix

- 注册表默认值与 `normalize("")` 不一致 → `TestEveryRegisteredConfigDefaultMatchesNormalizedEmpty` 失败
- 默认值本身非法（枚举不在 options / 整数越界）→ `TestEveryRegisteredConfigDefaultIsCanonical` 失败
- 新增分组忘配中文名 → `TestEveryRegisteredConfigGroupHasLabel` 失败
- 整数配置漏下发 min/max，或与校验边界不一致 → `TestRegisteredIntConfigsExposeMinMax` / `TestRegisteredIntConfigMinMaxMatchesValidation` 失败
- 库里没有记录 / 值为空串 → `GET /configs` 与 `GetRegisteredConfig()` 都返回 `def.DefaultValue`
- 库里已存在旧值 → `InitDefaultConfigs()` 只在值为空或校验不过时重写，**不会**把已有值升级成新默认值

### 5. Good/Base/Bad Cases

- Good：`backup_schedule_selection` 的默认值与 `normalizeBackupScheduleSelectionValue` 共用同一个常量，新装实例的定时备份默认包含任务视图。
- Base：新增一项配置时同时写好 key/label/默认值/说明/分组，客户端无需发版即可显示。
- Bad：注册表写 7 项、normalize 写 8 项。`/api/configs` 报出去的 `default_value`、`InitDefaultConfigs()` 首次建行写入的值、`GetRegisteredConfig()` 的回退值全都用缺项的那份，表现为「从未保存过备份设置的实例，定时备份不含任务视图」，且 Web 上那个勾选框默认没勾。
- Bad：把长句 `Description` 直接当输入框标题，`panel_runtime_mode` 那种三行说明会把表单撑烂。

### 6. Tests Required

见 `server/model/system_config_registry_test.go` 与 `server/handler/config_regression_test.go`：

- `TestEveryRegisteredConfigDefaultMatchesNormalizedEmpty`（**最重要的一条**，锁死声明默认值 == 生效默认值）
- `TestEveryRegisteredConfigDefaultIsCanonical`
- `TestBackupScheduleSelectionDefaultIncludesTaskViews`
- `TestEveryRegisteredConfigHasRenderMetadata` / `TestEveryRegisteredConfigGroupHasLabel`
- `TestRegisteredIntConfigsExposeMinMax` / `TestRegisteredIntConfigMinMaxMatchesValidation`
- `TestRegisteredSecretConfigsAreMarked` / `TestRegisteredEnumConfigsHaveOptions`
- `TestConfigListExposesRenderSchema` / `TestConfigListReportsCompleteBackupScheduleSelectionDefault`
- 修改后至少运行：

```bash
cd server
go test ./model ./handler -run "TestEveryRegisteredConfig|TestRegistered|TestBackupScheduleSelectionDefault|TestConfigList" -count=1
go test ./...
```

> **突变验证**：把 `backup_schedule_selection` 的默认值改回 7 项（去掉 `task_views`），`TestEveryRegisteredConfigDefaultMatchesNormalizedEmpty`、`TestBackupScheduleSelectionDefaultIncludesTaskViews`、`TestConfigListReportsCompleteBackupScheduleSelectionDefault` 必须确定性变红；若不红说明用例没有真正在检测这条不变量。

### 7. Wrong vs Correct

#### Wrong

```go
// 错误：默认值在注册表和 normalize 里各写一份字面量，改一处不会有任何报错。
newValidatedStringConfig(
    "backup_schedule_selection", "备份内容",
    "configs,tasks,subscriptions,env_vars,logs,scripts,dependencies",
    "...", "backup", normalizeBackupScheduleSelectionValue,
)

func normalizeBackupScheduleSelectionValue(value string) (string, error) {
    defaultValue := "configs,tasks,subscriptions,env_vars,logs,scripts,dependencies,task_views"
    // ...
}
```

```go
// 错误：取值区间只被闭包捕获，客户端拿不到，只能等用户填了越界值再被服务端 400 打回。
def: SystemConfigDefinition{Key: key, ValueType: SystemConfigTypeInt},
normalize: func(value string) (string, error) {
    if parsed < minValue || parsed > maxValue { /* ... */ }
},
```

#### Correct

```go
// 正确：默认值收成一个常量，注册表和 normalize 共用同一份。
const defaultBackupScheduleSelection = "configs,tasks,subscriptions,env_vars,logs,scripts,dependencies,task_views"
```

```go
// 正确：取值区间拷一份挂到 def 上，客户端可以做前端校验，服务端仍然独立校验一次。
minBound, maxBound := minValue, maxValue
def: SystemConfigDefinition{
    Key: key, ValueType: SystemConfigTypeInt,
    Min: &minBound, Max: &maxBound,
},
```
