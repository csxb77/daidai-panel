# 日志规范

> 当前项目既有 Gin 请求日志，也有面板运行日志，还会把部分日志写入数据目录。

---

## 当前真实做法

- 使用标准库 `log`
- Gin 使用自定义 writer 输出请求日志
- 面板启动时会根据运行模式把日志写到 `panel.log` 或 stdout
- 数据库层和部分兼容迁移也会通过 `log.Printf` 记录信息

---

## 应该记录什么

- 启动/关闭关键流程
- 数据库初始化和兼容迁移结果
- 调度器、资源监控、自动更新等关键后台流程
- 会影响用户使用的失败信息
- 安全相关事件，如登录、锁定、白名单限制等

---

## 不应该记录什么

- 明文密码
- token、refresh token、secret、私钥
- 用户敏感配置的完整原文
- 不必要的大段重复噪声日志

---

## 日志风格建议

- 文案尽量直接，便于排查。
- 如果是兼容逻辑、迁移逻辑、历史遗留兜底逻辑，建议加中文注释解释代码目的。
- 对可恢复的异常优先 `log.Printf`，对必须终止启动的问题再 `log.Fatalf`。

---

## 常见错误

- 把敏感信息直接打印到日志。
- 同一错误在循环中重复刷屏。
- 发生失败时没有打关键上下文，后面难排查。
- 只写“失败了”，不写哪个步骤失败。

## Scenario: 任务日志流中的终端覆盖刷新

### 1. Scope / Trigger
- Trigger: 修改 `server/service/script_runner.go`、`server/service/task_executor.go`、`server/service/scheduler.go`、`server/handler/log.go` 这条任务日志实时输出链时必须看本节。
- 原因: 进度条、下载器、CLI 状态条常用裸 `\r` 回到当前行开头覆盖内容；如果后端在读取脚本输出或写 SSE 时把 `\r` 直接洗成 `\n`，前端就只能把每次刷新渲染成新行，日志会被严重刷屏。

### 2. Signatures
- 脚本输出回调签名: `type OnOutputFunc func(chunk string)`
- 任务实时日志 SSE: `GET /api/v1/logs/:id/stream`
- 历史日志读取: `TaskLog.Content` / `TaskLog.LogPath`

### 3. Contracts
- `OnOutputFunc` 传递的是原始输出片段，不保证一定是完整一行。
- 片段内允许出现三种边界:
  - `\n`: 正常换行
  - `\r\n`: Windows 风格换行
  - 裸 `\r`: 终端单行覆盖刷新
- `writeSSEData` 只能把 `\r\n` 归一成 `\n`，不能把裸 `\r` 再改成 `\n`。
- **裸 `\r` 必须落在一条 `data:` 行的末尾，不能埋在行中间。** 这是上一条的补充约束，两条同时成立才算正确：
  - SSE 线格式里 CR、LF、CRLF **都是行终止符**。`data: aaa\rbbb\n` 会被标准 `EventSource` 拆成两行：`data: aaa` 和 `bbb`；后半段没有字段名，按规范整行**丢弃** —— `bbb` 静默消失。
  - 实现方式是**按裸 `\r` 分帧**：每碰到一个后面还有内容的裸 `\r`，就让它成为当前帧最后一条 `data:` 行的结尾，**写完帧终止空行**，剩余内容**另起一帧**。字符一个不增不减。
  - ⚠️ **绝不能改成「同一帧里多条以 `\r` 结尾的 `data:` 行」。** SSE 规定同一个 event 的多条 `data:` 行用 `\n` 拼接，那样裸 `\r` 会变成 `\r\n`，而前端 `web/src/utils/ansi.ts` 把 `\r\n` 当**真实换行**，进度条立刻刷屏 —— 正好是本节要防的那个回归。
  - 分帧方案对前端**零改动**：`web/src/utils/sse.ts` 按 `\n\n` 切帧、且对 `data:` 行末尾的 `\r` 刻意不 trim；`LogViewer.vue` 与 `logs/index.vue` 拿到相邻消息是**首尾相接 append**、不补任何分隔符。所以多帧拼起来与改动前的单帧**逐字节一致**。
  - **不变量**：把所有帧的 data 值按顺序首尾相接拼回去，必须逐字节等于输入（`\r\n`→`\n` 除外）。
- 任务执行器 / 调度器把输出写入 `TinyLog` 和日志文件时，必须原样写入片段，不能统一补 `+ "\n"`。

### 4. Validation & Error Matrix
- 输出只包含普通文本 + `\n` -> 正常按多行日志展示
- 输出包含 `\r\n` -> 视为真实换行
- 输出包含裸 `\r` -> 必须保留，交给前端按“覆盖当前行”处理
- 如果在任一后端环节把裸 `\r` 改成 `\n` -> 进度条日志会刷屏，属于行为回归
- 裸 `\r` 埋在 `data:` 行中间（`data: aaa\rbbb`）-> 标准 `EventSource` 把 `bbb` 当成无字段名的行**静默丢弃**，用户看到「进度条后面的输出没了」
- 裸 `\r` 之后另起一帧（`data: aaa\r` + 帧终止空行 + `data: bbb`）-> 内容完整、覆盖刷新语义保持、前端零改动，这是唯一正确的组合
- 裸 `\r` 之后不另起帧、只在同一帧里多写一条 `data:` 行 -> 同帧多条 data 按规范用 `\n` 拼接，裸 `\r` 变成 `\r\n`，进度条重新刷屏，同样是回归

### 5. Good/Base/Bad Cases
- Good: `xx 10%\rxx 20%\rxx 30%\n完成\n` 最终前端只显示一条持续刷新的进度行，再接一条“完成”
- Base: 普通 `print/console.log` 输出不受影响，仍然是逐行日志
- Bad: SSE 层把 `\r` 直接替换为 `\n`，导致 `10%`、`20%`、`30%` 全部堆成独立多行
- Bad: SSE 层只按 `\n` 切行，`\r` 留在 `data:` 行中间 —— 自研解析器看着正常，换成标准 `EventSource`（或中间有严格代理）时 `\r` 后面的内容整段消失，且**没有任何报错**
- Bad: 把 `\r` 后面的内容放进**同一帧**的下一条 `data:` 行（而不是另起一帧）—— 内容回来了，但同帧多条 data 会被 `\n` 拼接，裸 `\r` 变 `\r\n`，进度条重新刷屏

### 6. Tests Required
- 后端测试: `cd server && go test ./...`
- 回归点:
  - `server/handler/log_stream_regression_test.go` 断言 `writeSSEData` 会保留裸 `\r`
  - 同一个文件还要断言**分帧位置**：裸 `\r` 只能出现在某条 `data:` 行的最后一个字符，绝不能出现在行中间（一条断言两件事，否则「保留了但埋在中间」会全绿通过）
  - 任务执行日志链编译和现有 handler/service 测试全部通过

### 7. Wrong vs Correct
#### Wrong
```go
data = strings.ReplaceAll(data, "\r", "\n")
fmt.Fprintf(tinyLog, "%s\n", line)
logMgr.Write(fullLogPath, line+"\n")
```

```go
// 错误：只按 \n 切，裸 \r 被埋在 data: 行中间。
// 自研解析器看着没问题，标准 EventSource 会把 \r 后面的半截当成无字段名的行丢掉。
for _, line := range strings.Split(data, "\n") {
    fmt.Fprintf(w, "data: %s\n", line)
}
```

#### Correct
```go
data = strings.ReplaceAll(data, "\r\n", "\n")
fmt.Fprint(tinyLog, chunk)
logMgr.Write(fullLogPath, chunk)
```

```go
// 正确：\n 照旧在帧内切行；裸 \r 之后【另起一帧】，
// \r 本身留在上一帧最后一条 data: 行的末尾 —— 字符保住了，也不会被 EventSource 吞掉。
// 前端零改动：帧与帧首尾相接 append，拼回去与改动前逐字节一致。
data = strings.ReplaceAll(data, "\r\n", "\n")
for {
    segment, rest := data, ""
    // idx+1 == len(data) 表示 \r 已经在整段末尾，本来就落在行末，不用再切。
    if idx := strings.IndexByte(data, '\r'); idx >= 0 && idx+1 < len(data) {
        segment, rest = data[:idx+1], data[idx+1:]
    }
    for _, line := range strings.Split(segment, "\n") {
        fmt.Fprintf(w, "data: %s\n", line)
    }
    fmt.Fprint(w, "\n") // 帧终止空行必须写在循环内
    if rest == "" {
        return
    }
    data = rest
}
```

## Scenario: 日志清理的记录与文件一致性

### 1. Scope / Trigger

- Trigger: 修改 `server/service/log_cleanup.go`、`server/service/log_manager.go`、`server/handler/log.go`、
  `server/handler/task_logs.go`、`server/cmd/ddp/commands.go` 的 `clean-logs`，或新增任何一处「清理日志」入口时必须看本节。
- 原因: 「清理日志」在这个仓库里同时意味着**删 `task_logs` 行**和**删磁盘 `.log` 文件**两件事。
  v3.3.2 / issue #144 之前三个入口各做各的（自动清理删行也删文件、`/logs/clean` 只删行、`/tasks/clean-logs` 只删文件），
  同一句话在三个地方是三种结果，而这个不一致在规范里零记载——谁改都不知道另外两处存在。

### 2. Signatures

- 行 + 文件一起清（按天数）: `service.CleanLogsOlderThan(days int) (int64, int)`
- 行 + 文件一起清（按任务分组）: `service.CleanLogsByRetentionPolicy(globalDays int) (int64, int)`
- 只删文件（按 `log_path`）: `service.DeleteLogFilesForRecords(logPaths []string, logDir string) int`
- 只删文件（按 ModTime 扫盘）: `service.CleanOldLogs(logDir string, days int) int`
- 正在写入的文件判定: `(*LogStreamManager).IsStreamOpen(filePath string) bool`
- 入口: 自动清理 worker（`cleanupOldLogs`）、`DELETE /api/v1/logs/clean`、`DELETE /api/v1/tasks/clean-logs`、`ddp clean-logs`

### 3. Contracts

**记录与文件的一致性**

- **删 `task_logs` 行的代码路径必须同时按 `log_path` 删磁盘文件**，统一走 `CleanLogsOlderThan` /
  `CleanLogsByRetentionPolicy` / `DeleteLogFilesForRecords`，**不要再起第四条清理路径**。
- 顺序固定是「先 `Pluck` 出 `log_path` → 删 DB 行 → 删文件」：行一删，路径就再也查不回来了。
- 🔴 **任何按 status 过滤 `task_logs` 的 WHERE 都必须写成 `(status IS NULL OR status <> ?)`**，
  绝不能只写 `status <> ?`。`task_logs.status` 是可空列（`model.TaskLog.Status` 是 `*int`），
  SQL 三值逻辑下 `NULL <> 2` 求值为 **NULL 而不是 TRUE**，只写后者会把所有 status 为 NULL 的历史行**整批静默漏掉**——
  永远清不干净，而且接口照样返回成功，从响应里看不出任何异常。
- 🔴 **删任何日志文件前必须先过 `LogStreamManager.IsStreamOpen`**，入参必须是
  `filepath.Join(logDir, relPath)` 这个**未经 `EvalSymlinks`** 的路径——写入方（`task_executor.go` / `scheduler.go`）
  就是拿它当 map key 的，做了归一化就跟写入方对不上，判定恒为 false，这道保护等于没有。
  Linux 上 `os.Remove` 一个已 open 的文件**不报错**，随后的写入会全进被 unlink 的 inode，
  任务跑完日志凭空消失、一句报错都没有；Windows 上则是 Remove 直接失败。跳过的文件留给下一轮清理收。
- `CleanOldLogs` **刻意只管文件、不碰 DB 行**，不要「顺手」给它加上删行：
  `ddp clean-logs` 这条 CLI 与 `README.md`、`cmd/ddp/help.go` 的语义都是「清理任务日志文件」，改它要连文档一起改。
  它同时是「DB 行早没了、文件还在」这类存量垃圾的**唯一**清理手段（按 `log_path` 删根本找不到这些文件），
  所以不能被按 `log_path` 删取代，两者是互补关系。

**自动清理 vs 手动清理的分野**

- 自动清理 worker 走 `CleanLogsByRetentionPolicy`：任务自己设了 `log_retention_days` 就按它的 cutoff，其余跟随全局。
- 🔴 两个手动入口（`DELETE /logs/clean`、`DELETE /tasks/clean-logs`）**刻意仍走 `CleanLogsOlderThan`**，
  不要「统一一下」改成走分组。手动清理是用户明确指定「保留最近 N 天」的一次性动作，
  掺进任务级天数就会删掉用户刚说要留的日志（某任务设 1 天，用户点清理 30 天，结果它 1 天前的全没了）——
  那是越权删除，不是功能。
- **分组依据只认 `task_logs.task_id`，禁止从日志目录名解析 `task_<ID>`**：
  恢复备份时 `backup_runtime.go` 的 `restoreTasks` 把 `item.ID` 置 0、任务重新分配 ID，
  而 `log_path` 与磁盘目录是原样拷回的，按目录名取天数会把 A 任务的设置套到 B 任务头上。
- **分组清理末尾那次 ModTime 扫盘的天数必须取 `max(全局, 所有任务级天数)`**，不能用全局天数：
  扫盘只看文件时间、认不出文件属于哪个任务，某任务把天数调得比全局长时用全局天数扫，
  会造出「DB 行还在、文件没了」，用户点开日志是一片空白。
  代价是这种情况下孤儿垃圾要等更长天数才被扫走——可以接受；
  把天数调短这个主用例完全不受影响（那时 `max` 就等于全局）。
- 覆盖表只收 `log_retention_days IS NOT NULL AND log_retention_days > 0` 的任务，
  顺带挡掉手工改库塞进来的 0 和负数。

### 4. Validation & Error Matrix

- 只删 DB 行、不删文件 -> 磁盘上堆出永远没人认领的孤儿 `.log`，用户看到「清理了却没释放空间」
- 只删文件、不删 DB 行 -> 列表里还有记录，点开是空白
- WHERE 只写 `status <> ?` -> status 为 NULL 的历史行一条都删不掉，**静默**，接口仍回成功
- 删文件前不过 `IsStreamOpen` -> Linux 上正在跑的那次执行的日志写进被 unlink 的 inode，**静默丢失**
- `IsStreamOpen` 传了 `EvalSymlinks` 之后的路径 -> 判定恒 false，等于没有这道保护
- 手动入口改走 `CleanLogsByRetentionPolicy` -> 删掉用户在这次操作里明确说要留的日志
- 分组按目录名 `task_<ID>` 取天数 -> 恢复备份后 A 任务的保留天数被套到 B 任务上
- 扫盘用全局天数而非 `max` -> 「行还在、文件没了」

### 5. Good/Base/Bad Cases

- Good: 自动清理跑完，设了 1 天的高频任务只剩当天日志，其余任务按全局天数保留，正在跑的那次执行的日志文件完好
- Base: 没有任何任务设过 `log_retention_days` 时，`CleanLogsByRetentionPolicy` 的行为与按全局天数一刀切逐字节一致
- Bad: 新加一处「清理日志」按钮，自己写一段 `Delete(&model.TaskLog{})` 就收工，文件留在盘上
- Bad: 为了「三个入口统一」把手动清理也改成按任务分组
- Bad: 觉得 `CleanOldLogs` 不删记录是遗漏，给它补上删行——`ddp clean-logs` 的语义随之改变，且文档没跟

### 6. Tests Required

- 后端测试: `cd server && go test ./...`
- 回归点:
  - 存量行 `status` 为 NULL 时仍能被按天数清掉（把 WHERE 改回 `status <> ?` 必须变红）
  - 文件仍被 `LogStreamManager` 持有时跳过删除、DB 行的处理不受影响
  - 任务设了比全局短的天数 -> 只有该任务的日志按短天数清，其余按全局
  - 任务设了比全局长的天数 -> 扫盘按 `max` 走，该任务在全局天数之前的文件没被扫走
  - 手动清理入口在有任务级天数的库上，结论与「按全局天数一刀切」一致

### 7. Wrong vs Correct

#### Wrong

```go
// 错误一：NULL status 的历史行永远删不掉，且完全静默。
db.Where("started_at < ? AND status <> ?", cutoff, model.LogStatusRunning).Delete(&model.TaskLog{})

// 错误二：先删行再想去拿 log_path —— 路径已经没了。
db.Where("started_at < ?", cutoff).Delete(&model.TaskLog{})
db.Model(&model.TaskLog{}).Pluck("log_path", &paths)

// 错误三：删文件前不问有没有人正在写它。
os.Remove(filepath.Join(logDir, relPath))
```

#### Correct

```go
// 先 Pluck 再 Delete；WHERE 两处都要带上 (status IS NULL OR status <> ?)。
pathQuery := db.Model(&model.TaskLog{}).
    Where("started_at < ? AND (status IS NULL OR status <> ?)", cutoff, model.LogStatusRunning).
    Where("log_path IS NOT NULL AND log_path <> ''")
deleteQuery := db.
    Where("started_at < ? AND (status IS NULL OR status <> ?)", cutoff, model.LogStatusRunning)

var paths []string
pathQuery.Pluck("log_path", &paths)
result := deleteQuery.Delete(&model.TaskLog{})
// 删文件统一走它：内部逐条过 IsStreamOpen + ResolveWithinBase，并清掉被删空的 task_ 目录。
DeleteLogFilesForRecords(paths, logDir)
```
