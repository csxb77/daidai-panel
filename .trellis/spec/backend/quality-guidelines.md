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
