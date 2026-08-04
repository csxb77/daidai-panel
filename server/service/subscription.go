package service

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"daidai-panel/config"
	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/pkg/cron"

	"gorm.io/gorm"
)

type PullCallback func(line string)

func PullSubscription(sub *model.Subscription) (string, error) {
	return PullSubscriptionWithCallback(sub, nil)
}

func PullSubscriptionWithCallback(sub *model.Subscription, onOutput PullCallback) (string, error) {
	return PullSubscriptionWithContext(context.Background(), sub, onOutput)
}

func PullSubscriptionWithContext(ctx context.Context, sub *model.Subscription, onOutput PullCallback) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	startTime := time.Now()

	var sshKeyPath string
	if sub.SSHKeyID != nil {
		var sshKey model.SSHKey
		if err := database.DB.First(&sshKey, *sub.SSHKeyID).Error; err == nil {
			tmpFile, err := writeTempSSHKey(sshKey.PrivateKey)
			if err != nil {
				return "", fmt.Errorf("写入 SSH 密钥失败: %w", err)
			}
			defer os.Remove(tmpFile)
			sshKeyPath = tmpFile
		}
	}
	authCfg, err := buildGitAuthConfig(os.Environ(), sub.URL, sub, sshKeyPath)
	if err != nil {
		return "", err
	}
	defer authCfg.CleanupFunc()

	var fullLog strings.Builder
	emit := func(line string) {
		fullLog.WriteString(line)
		fullLog.WriteString("\n")
		if onOutput != nil {
			onOutput(line)
		}
	}

	emit(fmt.Sprintf("[开始拉取] %s (%s)", sub.Name, sub.Type))
	applySubscriptionForceOverwriteSetting(sub)

	var output string
	var pullErr error

	switch sub.Type {
	case model.SubTypeSingleFile:
		output, pullErr = pullSingleFileWithCallback(ctx, sub, sshKeyPath, emit)
	default:
		output, pullErr = pullGitRepoWithCallback(ctx, sub, authCfg, emit)
	}

	if pullErr == nil && ctx.Err() != nil {
		pullErr = fmt.Errorf("拉取已停止")
	}
	if pullErr == nil {
		pullErr = runSubscriptionHookIfConfigured(sub, emit)
	}
	if pullErr == nil && ctx.Err() != nil {
		pullErr = fmt.Errorf("拉取已停止")
	}
	if pullErr == nil {
		syncSubscriptionTasks(sub, emit)
	}

	duration := time.Since(startTime).Seconds()

	status := 0
	if pullErr != nil {
		status = 1
		emit(fmt.Sprintf("[错误] %s", pullErr.Error()))
	}

	emit(fmt.Sprintf("[完成] 耗时 %.2f 秒, 状态: %s", duration, map[int]string{0: "成功", 1: "失败"}[status]))

	subLog := model.SubLog{
		SubscriptionID: sub.ID,
		Status:         status,
		Content:        fullLog.String(),
		Duration:       duration,
	}
	database.DB.Create(&subLog)

	now := time.Now()
	database.DB.Model(sub).Updates(map[string]interface{}{
		"last_pull_at": &now,
		"status":       status,
	})

	return output, pullErr
}

func applySubscriptionForceOverwriteSetting(sub *model.Subscription) {
	if sub == nil || sub.Type != model.SubTypeGitRepo {
		return
	}
	overwrite := isConfigEnabled("subscription_force_overwrite", true)
	sub.ForceOverwrite = &overwrite
}

func runCmdWithCallback(ctx context.Context, cmd *exec.Cmd, emit PullCallback) (string, error) {
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return "", err
	}

	var buf strings.Builder
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 64*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()
		buf.WriteString(line)
		buf.WriteString("\n")
		emit(line)
	}
	if scanErr := scanner.Err(); scanErr != nil {
		if ctx != nil && ctx.Err() != nil {
			return buf.String(), fmt.Errorf("拉取已停止")
		}
		return buf.String(), scanErr
	}

	err = cmd.Wait()
	if ctx != nil && ctx.Err() != nil {
		return buf.String(), fmt.Errorf("拉取已停止")
	}
	if err != nil {
		// clone / fetch / checkout / reset / sparse-checkout 全部走这一个出口，
		// 所以错误识别也统一放这里：调用方拿到的只有 `exit status 128`，
		// 真正的原因在刚刚 emit 出去的那几行 fatal 里。这里紧跟着追加一条
		// 中文提示，让「原因」和「原始输出」在日志里挨着，原始输出一行不删。
		if hint := classifyGitFailure(buf.String(), err); hint != "" {
			emit(hint)
		}
	}
	return buf.String(), err
}

func gitHasWorkingTreeChanges(ctx context.Context, repoDir string, env []string) (bool, error) {
	cmd := exec.CommandContext(ctx, "git", "status", "--porcelain", "--untracked-files=all")
	cmd.Dir = repoDir
	cmd.Env = env

	output, err := cmd.Output()
	if err != nil {
		if ctx != nil && ctx.Err() != nil {
			return false, fmt.Errorf("拉取已停止")
		}
		// 这条命令用的是 cmd.Output()，stderr 不进日志流；直接抛 err 的话
		// 用户只能看到 `exit status 128`，所以把 stderr 原文一并带上。
		return false, wrapGitCommandError("检查本地改动", gitCommandStderr(err), err)
	}

	return strings.TrimSpace(string(output)) != "", nil
}

func pullGitRepoWithCallback(ctx context.Context, sub *model.Subscription, authCfg gitAuthConfig, emit PullCallback) (string, error) {
	saveDir := sub.SaveDir
	if saveDir == "" {
		saveDir = sub.Alias
		if saveDir == "" {
			parts := strings.Split(sub.URL, "/")
			saveDir = strings.TrimSuffix(parts[len(parts)-1], ".git")
		}
	}

	destDir := filepath.Join(config.C.Data.ScriptsDir, saveDir)
	if absDestDir, err := filepath.Abs(destDir); err == nil {
		destDir = absDestDir
	}
	env := authCfg.Env

	if IsGitRepo(destDir) {
		var fullOutput strings.Builder
		branchLabel := "默认分支"
		if strings.TrimSpace(sub.Branch) != "" {
			branchLabel = strings.TrimSpace(sub.Branch)
		}

		emit(fmt.Sprintf("[检测到已有仓库] %s 已存在 Git 仓库，接下来会同步远端并覆盖更新本地文件", saveDir))
		emit(fmt.Sprintf("[同步远端地址] 正在校正订阅地址 -> %s", authCfg.DisplayURL))
		output, err := syncGitRemoteWithCallback(ctx, destDir, authCfg.RemoteURL, env, emit)
		fullOutput.WriteString(output)
		if err != nil {
			return fullOutput.String(), err
		}

		fetchArgs := []string{"fetch", "--depth", "1", "--prune", "origin"}
		if strings.TrimSpace(sub.Branch) != "" {
			fetchArgs = append(fetchArgs, strings.TrimSpace(sub.Branch))
		}
		emit(fmt.Sprintf("[拉取远端更新] 正在获取分支 %s 的最新提交", branchLabel))
		cmd := exec.CommandContext(ctx, "git", fetchArgs...)
		cmd.Dir = destDir
		cmd.Env = env
		output, err = runCmdWithCallback(ctx, cmd, emit)
		fullOutput.WriteString(output)
		if err != nil {
			return fullOutput.String(), err
		}

		if err := applySparseCheckout(ctx, destDir, sub, env, emit); err != nil {
			return fullOutput.String(), err
		}

		forceOverwrite := sub.ForceOverwrite == nil || *sub.ForceOverwrite
		if forceOverwrite {
			emit("[覆盖更新本地文件] 正在用远端最新提交覆盖当前订阅目录中的仓库内容")
			cmd = exec.CommandContext(ctx, "git", "reset", "--hard", "FETCH_HEAD")
			cmd.Dir = destDir
			cmd.Env = env
			output, err = runCmdWithCallback(ctx, cmd, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}
			emit("[已完成] 已覆盖更新所有仓库文件，本地新增的文件已保留")
		} else {
			emit("[保留本地修改] 正在合并远端更新（保留本地修改的文件）")
			hasStash, err := gitHasWorkingTreeChanges(ctx, destDir, env)
			if err != nil {
				return fullOutput.String(), err
			}
			if hasStash {
				cmd = exec.CommandContext(ctx, "git", "stash", "push", "--include-untracked", "-m", "daidai-panel-subscription-update")
				cmd.Dir = destDir
				cmd.Env = env
				output, err = runCmdWithCallback(ctx, cmd, emit)
				fullOutput.WriteString(output)
				if err != nil {
					return fullOutput.String(), err
				}
			} else {
				emit("[保留本地修改] 未检测到本地改动，跳过暂存恢复")
			}

			cmd = exec.CommandContext(ctx, "git", "reset", "--hard", "FETCH_HEAD")
			cmd.Dir = destDir
			cmd.Env = env
			output, err = runCmdWithCallback(ctx, cmd, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}

			if hasStash {
				emit("[恢复本地修改] 正在恢复之前暂存的本地修改")
				cmd = exec.CommandContext(ctx, "git", "stash", "pop")
				cmd.Dir = destDir
				cmd.Env = env
				output, err = runCmdWithCallback(ctx, cmd, emit)
				fullOutput.WriteString(output)
				if err != nil {
					emit("[提示] 本地修改与远端更新存在冲突，请手动处理")
				}
			}
		}
		return fullOutput.String(), err
	}

	if destInfo, err := os.Stat(destDir); err == nil {
		if !destInfo.IsDir() {
			return "", fmt.Errorf("保存目录已被文件占用: %s", saveDir)
		}

		entries, readErr := os.ReadDir(destDir)
		if readErr != nil {
			return "", fmt.Errorf("读取保存目录失败: %w", readErr)
		}
		if len(entries) > 0 {
			var fullOutput strings.Builder
			branchLabel := "默认分支"
			if strings.TrimSpace(sub.Branch) != "" {
				branchLabel = strings.TrimSpace(sub.Branch)
			}

			emit(fmt.Sprintf("[检测到已存在脚本目录] %s 当前不是 Git 仓库，接下来会原地初始化仓库并覆盖本地文件", saveDir))
			emit("[git init] 正在初始化本地仓库")
			cmd := exec.CommandContext(ctx, "git", "init")
			cmd.Dir = destDir
			cmd.Env = env
			output, err := runCmdWithCallback(ctx, cmd, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}

			emit(fmt.Sprintf("[同步远端地址] 正在校正订阅地址 -> %s", authCfg.DisplayURL))
			output, err = syncGitRemoteWithCallback(ctx, destDir, authCfg.RemoteURL, env, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}

			fetchArgs := []string{"fetch", "--depth", "1", "--prune", "origin"}
			if strings.TrimSpace(sub.Branch) != "" {
				fetchArgs = append(fetchArgs, strings.TrimSpace(sub.Branch))
			}
			emit(fmt.Sprintf("[拉取远端更新] 正在获取分支 %s 的最新提交", branchLabel))
			cmd = exec.CommandContext(ctx, "git", fetchArgs...)
			cmd.Dir = destDir
			cmd.Env = env
			output, err = runCmdWithCallback(ctx, cmd, emit)
			if err != nil {
				fullOutput.WriteString(output)
				return fullOutput.String(), err
			}
			fullOutput.WriteString(output)
			if ctx.Err() != nil {
				return fullOutput.String(), fmt.Errorf("拉取已停止")
			}

			if err := applySparseCheckout(ctx, destDir, sub, env, emit); err != nil {
				return fullOutput.String(), err
			}

			emit("[覆盖更新本地文件] 正在用远端最新提交覆盖当前脚本目录内容")
			cmd = exec.CommandContext(ctx, "git", "reset", "--hard", "FETCH_HEAD")
			cmd.Dir = destDir
			cmd.Env = env
			output, err = runCmdWithCallback(ctx, cmd, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}

			emit("[清理多余文件] 正在移除原脚本目录中不属于远端仓库的旧文件")
			cmd = exec.CommandContext(ctx, "git", "clean", "-fd")
			cmd.Dir = destDir
			cmd.Env = env
			output, err = runCmdWithCallback(ctx, cmd, emit)
			fullOutput.WriteString(output)
			if err != nil {
				return fullOutput.String(), err
			}

			emit("[已完成] 已覆盖更新所有仓库文件，并清理原目录中的多余旧文件")
			return fullOutput.String(), nil
		}
	}

	emit(fmt.Sprintf("[git clone] %s -> %s", authCfg.DisplayURL, saveDir))
	os.MkdirAll(destDir, 0755)
	args := []string{"clone", "--depth", "1"}
	// 告警统一在 applySparseCheckout 里 emit，这里只关心「要不要延后检出」。
	sparsePatterns, _ := buildSubscriptionSparseCheckoutPatterns(sub)
	if len(sparsePatterns) > 0 {
		// 有指定子目录/白名单时，先不检出工作区，避免 clone 阶段把整个仓库文件落盘。
		// --filter=blob:none 对 GitHub 这类支持 partial clone 的远端能少下载无关 blob；
		// 不支持的远端会退化为普通浅克隆，但工作区仍只会检出匹配路径。
		args = append(args, "--filter=blob:none", "--no-checkout")
	}
	if sub.Branch != "" {
		args = append(args, "-b", sub.Branch)
	}
	args = append(args, authCfg.RemoteURL, destDir)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = config.C.Data.ScriptsDir
	cmd.Env = env
	output, err := runCmdWithCallback(ctx, cmd, emit)
	if err != nil {
		return output, err
	}
	if len(sparsePatterns) > 0 {
		var fullOutput strings.Builder
		fullOutput.WriteString(output)
		if spErr := applySparseCheckout(ctx, destDir, sub, env, emit); spErr != nil {
			return fullOutput.String(), spErr
		}
		emit("[checkout] 正在按子目录/白名单规则检出订阅文件")
		cmd = exec.CommandContext(ctx, "git", "checkout", "HEAD")
		cmd.Dir = destDir
		cmd.Env = env
		output, err = runCmdWithCallback(ctx, cmd, emit)
		fullOutput.WriteString(output)
		return fullOutput.String(), err
	}
	return output, nil
}

// subscriptionSparseUnsafeChars 列出会让 sparse-checkout「静默少匹配」的 gitignore 元字符。
//
// `git sparse-checkout set --no-cone` 用的是 gitignore 语法：`?` 匹配任意单字符、
// `[...]` 是字符类、`\` 是转义符。我们把用户填的过滤词包成 `**/*词*` 时，
// 词里若含这些字符，git 会按通配语义解释而不是字面量，结果往往是
// 「一个文件都没检出、且完全不报错」——本类 bug 最难排查的形态。
//
// `*` 刻意不在此列：它只会放宽匹配、不会导致漏检出，方向是安全的。
// `|` 也不在此列：它在 gitignore 里就是普通字符，现在已经在
// splitSubscriptionFilterPatterns 阶段被当作分隔符拆掉了。
const subscriptionSparseUnsafeChars = "?[]\\"

// subscriptionSparseUnsafeCharsHint 是给用户看的可读版本（日志里直接打元字符会糊成一团）。
const subscriptionSparseUnsafeCharsHint = "? [ ] \\"

// splitSubscriptionSparseTargets 把过滤字段拆成两组：
// 能安全下发给 sparse-checkout 的模式，和含 gitignore 元字符、下发后会静默失配的模式。
func splitSubscriptionSparseTargets(raw string) (safe []string, risky []string) {
	for _, p := range splitSubscriptionFilterPatterns(raw) {
		p = normalizeSubscriptionFilterTarget(p)
		if p == "" || isWildcardFilterPattern(p) {
			continue
		}
		if strings.ContainsAny(p, subscriptionSparseUnsafeChars) {
			risky = append(risky, p)
			continue
		}
		safe = append(safe, p)
	}
	return safe, risky
}

func formatSubscriptionPatternList(patterns []string) string {
	quoted := make([]string, 0, len(patterns))
	for _, p := range patterns {
		quoted = append(quoted, "`"+p+"`")
	}
	return strings.Join(quoted, " / ")
}

// buildSubscriptionSparseCheckoutPatterns 返回下发给 git sparse-checkout 的规则，
// 以及需要打给用户看的告警（调用方负责 emit）。
func buildSubscriptionSparseCheckoutPatterns(sub *model.Subscription) (patterns []string, warnings []string) {
	if sub == nil {
		return nil, nil
	}

	seen := map[string]bool{}
	addPattern := func(pattern string) {
		pattern = strings.TrimSpace(filepath.ToSlash(pattern))
		pattern = strings.TrimPrefix(pattern, "./")
		pattern = strings.TrimPrefix(pattern, "/")
		if pattern == "" || seen[pattern] {
			return
		}
		seen[pattern] = true
		patterns = append(patterns, pattern)
	}

	subPaths, unsafeSubPaths := splitSubscriptionSparseTargets(sub.SubPath)
	whitelist, unsafeWhitelist := splitSubscriptionSparseTargets(sub.Whitelist)
	blacklist, unsafeBlacklist := splitSubscriptionSparseTargets(sub.Blacklist)

	// 包含侧（指定子目录 / 白名单）是「或」语义：只跳过其中一条不安全的子模式，
	// 会让那条本该命中的文件静默检不出来，用户看到的还是「拉取成功但任务是空的」。
	// 所以只要有一条不安全，就整体放弃包含侧的 sparse 限制、改为检出完整仓库，
	// 再交给 Go 侧的 matchesSubscriptionFilters 决定给哪些脚本建任务。
	// 宁可多落几个文件，也不要静默丢文件。
	switch {
	case len(unsafeSubPaths) > 0:
		warnings = append(warnings, fmt.Sprintf(
			"[警告] 指定子目录 %s 含 git 通配特殊字符（%s），无法安全转成 sparse-checkout 规则；本次改为检出完整仓库，请改用不含这些字符的普通路径片段",
			formatSubscriptionPatternList(unsafeSubPaths), subscriptionSparseUnsafeCharsHint))
	case len(subPaths) > 0:
		// 指定子目录优先级最高：它代表用户明确只想要仓库里的某几个目录/文件。
		for _, p := range subPaths {
			addPattern(p)
		}
	case len(unsafeWhitelist) > 0:
		warnings = append(warnings, fmt.Sprintf(
			"[警告] 白名单 %s 含 git 通配特殊字符（%s），无法安全转成 sparse-checkout 规则；本次改为检出完整仓库，扫描任务时仍按白名单过滤。白名单是「子串包含」匹配，不支持正则",
			formatSubscriptionPatternList(unsafeWhitelist), subscriptionSparseUnsafeCharsHint))
	default:
		// 没有指定子目录时，才用白名单限制真实检出的文件范围。
		// 白名单历史上是"路径包含匹配"，这里用 **/*xxx* 尽量保持同样的直觉。
		for _, p := range whitelist {
			addPattern("**/*" + p + "*")
		}
	}

	// 黑名单是「排除」语义：跳过一条不安全的排除规则，只会让对应文件多落一份盘，
	// Go 侧的 checkBlacklist 仍然会把它们挡在定时任务之外，方向是安全的，逐条跳过即可。
	if len(unsafeBlacklist) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"[警告] 黑名单 %s 含 git 通配特殊字符（%s），已跳过对应的 sparse-checkout 排除规则；这些文件仍会落盘，但不会被建成定时任务",
			formatSubscriptionPatternList(unsafeBlacklist), subscriptionSparseUnsafeCharsHint))
	}

	if len(blacklist) == 0 {
		// 包含侧被迫放弃、又没有可用排除规则时 patterns 为空，
		// 等价于「不做任何过滤」，直接返回空让调用方关掉 sparse-checkout。
		return patterns, warnings
	}

	// 只有黑名单（或包含侧被迫放弃）时先包含全部，再用 !pattern 排除，
	// 避免"黑名单目录"也落到 scripts 里。
	if len(patterns) == 0 {
		addPattern("*")
	}
	for _, p := range blacklist {
		addPattern("!**/*" + p + "*")
	}

	return patterns, warnings
}

func applySparseCheckout(ctx context.Context, repoDir string, sub *model.Subscription, env []string, emit PullCallback) error {
	patterns, warnings := buildSubscriptionSparseCheckoutPatterns(sub)
	// 先把告警打出来：这类问题的杀伤力全在「静默」，哪怕后面走了兜底也要让用户看见。
	for _, warning := range warnings {
		emit(warning)
	}
	if len(patterns) == 0 {
		// 用户清空子目录/白名单后，要把之前的 sparse-checkout 关掉，
		// 否则旧过滤规则会一直残留，导致后续看起来"仓库文件丢了"。
		cmd := exec.CommandContext(ctx, "git", "config", "--bool", "core.sparseCheckout")
		cmd.Dir = repoDir
		cmd.Env = env
		output, err := cmd.Output()
		if err == nil && strings.TrimSpace(string(output)) == "true" {
			emit("[sparse-checkout] 当前未配置子目录/白名单，正在恢复完整仓库检出")
			cmd = exec.CommandContext(ctx, "git", "sparse-checkout", "disable")
			cmd.Dir = repoDir
			cmd.Env = env
			if _, runErr := runCmdWithCallback(ctx, cmd, emit); runErr != nil {
				return fmt.Errorf("关闭 sparse-checkout 失败: %w", runErr)
			}
		}
		return nil
	}

	emit(fmt.Sprintf("[sparse-checkout] 设置订阅路径过滤（共 %d 条）: %s", len(patterns), strings.Join(patterns, ", ")))

	cmd := exec.CommandContext(ctx, "git", "sparse-checkout", "init", "--no-cone")
	cmd.Dir = repoDir
	cmd.Env = env
	if _, err := runCmdWithCallback(ctx, cmd, emit); err != nil {
		return fmt.Errorf("sparse-checkout init 失败: %w", err)
	}

	args := append([]string{"sparse-checkout", "set", "--no-cone"}, patterns...)
	cmd = exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir
	cmd.Env = env
	if _, err := runCmdWithCallback(ctx, cmd, emit); err != nil {
		return fmt.Errorf("sparse-checkout set 失败: %w", err)
	}

	return nil
}

func pullSingleFileWithCallback(ctx context.Context, sub *model.Subscription, _ string, emit PullCallback) (string, error) {
	saveDir := sub.SaveDir
	if saveDir == "" {
		saveDir = "downloads"
	}

	parts := strings.Split(sub.URL, "/")
	filename := parts[len(parts)-1]
	if sub.Alias != "" {
		filename = sub.Alias
	}

	destPath := filepath.Join(config.C.Data.ScriptsDir, saveDir, filename)
	emit(fmt.Sprintf("[下载] %s -> %s/%s", sub.URL, saveDir, filename))
	output, err := DownloadFileWithContext(ctx, sub.URL, destPath)
	if output != "" {
		emit(output)
	}
	return output, err
}

func syncGitRemoteWithCallback(ctx context.Context, repoDir, remoteURL string, env []string, emit PullCallback) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "remote")
	cmd.Dir = repoDir
	cmd.Env = env

	remoteOutput, err := cmd.Output()
	if err != nil {
		if ctx != nil && ctx.Err() != nil {
			return "", fmt.Errorf("拉取已停止")
		}
		// 同 gitHasWorkingTreeChanges：cmd.Output() 的 stderr 不会 emit 出去，
		// 不带上原文的话用户只能看到一句退出码。
		return "", wrapGitCommandError("读取远端配置", gitCommandStderr(err), err)
	}

	args := []string{"remote", "add", "origin", remoteURL}
	for _, name := range strings.Fields(string(remoteOutput)) {
		if name == "origin" {
			args = []string{"remote", "set-url", "origin", remoteURL}
			break
		}
	}

	cmd = exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoDir
	cmd.Env = env
	return runCmdWithCallback(ctx, cmd, emit)
}

func writeTempSSHKey(privateKey string) (string, error) {
	tmpFile, err := os.CreateTemp("", "ssh_key_*")
	if err != nil {
		return "", err
	}
	defer tmpFile.Close()

	if _, err := tmpFile.WriteString(privateKey); err != nil {
		os.Remove(tmpFile.Name())
		return "", err
	}

	os.Chmod(tmpFile.Name(), 0600)
	return tmpFile.Name(), nil
}

var (
	// 兼容多种 cron 声明前缀：
	//   cron: 30 8 * * *
	//   # cron: 30 8 * * *
	//   #cron 8 9,10,11 * * *
	//   cron 0 12 * * *
	//   * cron 8 10 * * *           (JSDoc 块注释每行的 `*` 前缀)
	//   * cron: 12 8 * * *
	//   @cron: 30 8 * * *           (JSDoc `@cron` 标签)
	//   * @cron 0 0 * * *
	//   // cron: 0 0 * * *
	// 通过 `\b` 词界避免误匹配 `crontab` / `cron-utils` 等关键字。
	cronLabelPrefixRe      = regexp.MustCompile(`(?im)^[\s#*@/]*@?cron\b\s*[:：]?\s*(\S.*)$`)
	subscriptionTaskNameRe = regexp.MustCompile(`new\s+Env\s*\(\s*['"` + "`" + `]([^'"` + "`" + `]+)['"` + "`" + `]\s*\)`)
	// 青龙风格 `cron "EXPR" filename, tag:xxx` 单行声明，常见于 JS 顶部注释。
	// 例如：cron "6 6 6 6 *" jd_CheckCK.js, tag:京东CK检测by-ccwav
	cronDirectiveLineRe = regexp.MustCompile(`(?i)\bcron\s+["']([^"'\n\r]+)["']\s+([^\s,;]+)`)
)

type subscriptionTaskSyncOptions struct {
	autoAdd     bool
	autoDelete  bool
	defaultCron string
	allowedExts map[string]bool
}

type subscriptionTaskCandidate struct {
	Name           string
	Command        string
	CronExpression string
}

func subscriptionTaskLabel(subID uint) string {
	return fmt.Sprintf("subscription:%d", subID)
}

func hasLabel(labels []string, target string) bool {
	for _, item := range labels {
		if item == target {
			return true
		}
	}
	return false
}

func withLabel(labels []string, target string) []string {
	if hasLabel(labels, target) {
		return labels
	}
	return append(labels, target)
}

func subscriptionSaveDir(sub *model.Subscription) string {
	saveDir := sub.SaveDir
	if saveDir == "" {
		saveDir = sub.Alias
		if saveDir == "" {
			parts := strings.Split(sub.URL, "/")
			saveDir = strings.TrimSuffix(parts[len(parts)-1], ".git")
		}
	}
	return saveDir
}

// isWildcardFilterPattern 判断"用户填的 pattern 是不是通配符"——
// 如 `*`、`**`、`*.*`、`.*`、`/`、`all`。这些显然是用户想"全部放行"的意图，
// 但旧逻辑用 strings.Contains 字面匹配 → 全部不匹配 → 全部文件被过滤掉。
// 现在视为"等价于不填"。
func isWildcardFilterPattern(p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return true
	}
	switch strings.ToLower(p) {
	case "*", "**", "*.*", ".*", "/", "all", "any", "全部":
		return true
	}
	return false
}

func normalizeSubscriptionFilterTarget(value string) string {
	value = strings.TrimSpace(filepath.ToSlash(value))
	value = strings.TrimPrefix(value, "./")
	value = strings.TrimPrefix(value, "/")
	return value
}

func subscriptionFilterContains(target string, pattern string) bool {
	target = normalizeSubscriptionFilterTarget(target)
	pattern = normalizeSubscriptionFilterTarget(pattern)
	if target == "" || pattern == "" {
		return false
	}
	return strings.Contains(target, pattern)
}

// splitSubscriptionFilterPatterns 把「指定子目录 / 白名单 / 黑名单」这三个过滤字段
// 拆成一组独立模式。分隔符同时接受 `,` 和 `|`。
//
// 为什么必须认 `|`：用户最主要的配置来源是青龙的 `ql repo` 命令，它的第 2/3/4 个
// 位置参数是 `grep -E` 模式，天然用 `|` 分隔：
//
//	ql repo https://github.com/6dylan6/jdpro.git "jd_|jx_|jddj_" "backUp" "..."
//
// 旧实现只按 `,` 拆 → 整串 `jd_|jx_|jddj_` 被当成一个模式，三条链路同时失效：
//  1. buildSubscriptionSparseCheckoutPatterns 生成 `**/*jd_|jx_|jddj_*`，
//     而 gitignore 语法里 `|` 只是普通字符不是「或」→ sparse-checkout 检出 0 个文件；
//  2. matchesSubscriptionWhitelist 做 strings.Contains(路径, "jd_|jx_|jddj_") → 恒 false；
//  3. checkBlacklist 同理。
//
// 表现就是「git 拉取成功、日志没有任何报错、但扫描 0 个候选文件、一个定时任务都没建」。
//
// 注意：这里只改「分隔」，不引入正则。本项目既有语义是子串包含
// （见 subscriptionFilterContains），贸然改成正则会让现存配置里含 `.` `*` `+` `(`
// 的普通子串行为突变，属于破坏性变更。
func splitSubscriptionFilterPatterns(raw string) []string {
	var patterns []string
	seen := make(map[string]bool)
	for _, pattern := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '|'
	}) {
		pattern = strings.TrimSpace(pattern)
		// 空段必须丢弃：`jd_||jx_`、`jd_,,jx_`、`|jd_|` 这类首尾/连续分隔符很常见，
		// 而空模式会让 subscriptionFilterContains 恒 false，
		// 也会让 sparse-checkout 生成 `**/**` 这种含义完全跑偏的规则。
		if pattern == "" || seen[pattern] {
			continue
		}
		seen[pattern] = true
		patterns = append(patterns, pattern)
	}
	return patterns
}

func hasNonWildcardSubscriptionFilter(raw string) bool {
	for _, pattern := range splitSubscriptionFilterPatterns(raw) {
		if !isWildcardFilterPattern(pattern) {
			return true
		}
	}
	return false
}

func matchesSubscriptionWhitelist(sub *model.Subscription, filePath string) bool {
	hasNonWildcard := false
	for _, pattern := range splitSubscriptionFilterPatterns(sub.Whitelist) {
		if isWildcardFilterPattern(pattern) {
			return true
		}
		hasNonWildcard = true
		if subscriptionFilterContains(filePath, pattern) {
			return true
		}
	}
	return !hasNonWildcard
}

func matchesSubscriptionFilters(sub *model.Subscription, filePath string) bool {
	if !matchesSubscriptionWhitelist(sub, filePath) {
		return false
	}
	return checkBlacklist(sub, filePath)
}

// checkBlacklist 复用 splitSubscriptionFilterPatterns，不再自己写一份 strings.Split(",")。
// 之前那份重复实现是 `|` 分隔失效的三个现场之一：白名单改好了黑名单还是不认 `|`。
func checkBlacklist(sub *model.Subscription, filePath string) bool {
	for _, pattern := range splitSubscriptionFilterPatterns(sub.Blacklist) {
		if isWildcardFilterPattern(pattern) {
			continue
		}
		if subscriptionFilterContains(filePath, pattern) {
			return false
		}
	}
	return true
}

func syncSubscriptionTasks(sub *model.Subscription, emit PullCallback) {
	options := getSubscriptionTaskSyncOptions(sub)
	if !options.autoAdd && !options.autoDelete {
		emit("[跳过自动同步任务] 订阅与系统设置中均未启用 auto_add_cron / auto_del_cron")
		return
	}

	saveDir := subscriptionSaveDir(sub)
	scriptsDir := filepath.Join(config.C.Data.ScriptsDir, saveDir)
	candidates := collectSubscriptionTaskCandidates(sub, options)
	label := subscriptionTaskLabel(sub.ID)

	// 可观测兜底：v2.2.8 之前任何空候选 / DB 创建失败都被静默吞掉，用户只看到
	// "[完成]" 就以为同步成功了。这里把每一步都打日志出来。
	scannedFileCount := countSubscriptionScriptFiles(scriptsDir, options.allowedExts, sub)
	emit(fmt.Sprintf("[扫描脚本] 目录 %s 共扫描 %d 个候选文件（按白/黑名单过滤后），识别出 %d 个含 cron 的脚本",
		scriptsDir, scannedFileCount, len(candidates)))
	if len(candidates) == 0 && scannedFileCount > 0 {
		emit("[提示] 仓库内有脚本但没有识别到 cron 表达式：请检查脚本头部是否含 `cron <表达式>` 注释，或在系统设置 default_cron_rule 里配置默认 cron")
	}
	// 扫到 0 个文件是「静默失败」最典型的落点：拉取全绿、日志无错、任务列表空。
	// 把最可能的三个原因直接摊开，别让用户去猜。
	if scannedFileCount == 0 {
		emit("[提示] 没有扫描到任何候选脚本，常见原因：1) 指定子目录/白名单/黑名单把文件全过滤掉了（多个模式用 `,` 或 `|` 分隔，匹配方式是「子串包含」而非正则）；2) 上一步 sparse-checkout 规则没命中任何文件；3) 系统设置 repo_file_extensions 不含该脚本扩展名")
	}

	var managedTasks []model.Task
	queryTasksByLabel(label).Find(&managedTasks)
	managedByCommand := make(map[string]*model.Task, len(managedTasks))
	for i := range managedTasks {
		managedByCommand[strings.TrimSpace(managedTasks[i].Command)] = &managedTasks[i]
	}

	created := 0
	updated := 0
	deleted := 0
	adopted := 0
	failed := 0

	if options.autoAdd {
		for command, candidate := range candidates {
			if existing, ok := managedByCommand[command]; ok {
				changes := map[string]interface{}{}
				if existing.Name != candidate.Name {
					changes["name"] = candidate.Name
					existing.Name = candidate.Name
				}
				if existing.CronExpression != candidate.CronExpression {
					changes["cron_expression"] = candidate.CronExpression
					existing.CronExpression = candidate.CronExpression
				}
				if len(changes) > 0 {
					if err := database.DB.Model(existing).Updates(changes).Error; err != nil {
						failed++
						emit(fmt.Sprintf("[自动更新任务失败] %s: %v", candidate.Name, err))
					} else {
						GetSchedulerV2().UpdateJob(existing)
						updated++
						emit(fmt.Sprintf("[自动更新任务] %s (cron: %s)", candidate.Name, candidate.CronExpression))
					}
				}
				continue
			}

			var existing model.Task
			if err := database.DB.Where("command = ?", command).First(&existing).Error; err == nil {
				labels := withLabel(existing.GetLabels(), label)
				existing.SetLabelsFromSlice(labels)
				if err := database.DB.Model(&existing).Update("labels", existing.Labels).Error; err != nil {
					failed++
					emit(fmt.Sprintf("[关联已有任务失败] %s: %v", existing.Name, err))
				} else {
					managedByCommand[command] = &existing
					adopted++
					emit(fmt.Sprintf("[关联已有任务] %s", existing.Name))
				}
				continue
			}

			task := model.Task{
				Name:            candidate.Name,
				Command:         candidate.Command,
				CronExpression:  candidate.CronExpression,
				TaskType:        model.TaskTypeCron,
				Status:          model.TaskStatusEnabled,
				Timeout:         0,
				NotifyOnFailure: true,
			}
			task.SetLabelsFromSlice([]string{label})
			if err := database.DB.Select("*").Create(&task).Error; err != nil {
				failed++
				emit(fmt.Sprintf("[自动添加任务失败] %s (cron: %s) command=%s err=%v",
					candidate.Name, candidate.CronExpression, candidate.Command, err))
			} else {
				GetSchedulerV2().AddJob(&task)
				managedByCommand[command] = &task
				created++
				emit(fmt.Sprintf("[自动添加任务] %s (cron: %s)", candidate.Name, candidate.CronExpression))
			}
		}
	}

	if options.autoDelete {
		for _, task := range managedTasks {
			command := strings.TrimSpace(task.Command)
			if !strings.HasPrefix(command, "task ") {
				continue
			}
			if _, ok := candidates[command]; ok {
				continue
			}

			GetSchedulerV2().RemoveJob(task.ID)
			database.DB.Where("task_id = ?", task.ID).Delete(&model.TaskLog{})
			database.DB.Delete(&task)
			deleted++
			emit(fmt.Sprintf("[自动删除任务] %s", task.Name))
		}
	}

	if created > 0 {
		emit(fmt.Sprintf("[共自动添加 %d 个定时任务]", created))
	}
	if updated > 0 {
		emit(fmt.Sprintf("[共自动更新 %d 个定时任务]", updated))
	}
	if adopted > 0 {
		emit(fmt.Sprintf("[共关联 %d 个已有任务]", adopted))
	}
	if deleted > 0 {
		emit(fmt.Sprintf("[共自动删除 %d 个失效任务]", deleted))
	}
	if failed > 0 {
		emit(fmt.Sprintf("[警告] 共 %d 个任务操作失败，详见上方日志", failed))
	}
	if created == 0 && updated == 0 && adopted == 0 && deleted == 0 && failed == 0 {
		emit("[同步完成] 本次未对定时任务做任何变更")
	}
}

// countSubscriptionScriptFiles 统计 scriptsDir 下符合扩展名 + 白/黑名单过滤的文件数。
// 仅用于日志可观测：让用户知道"扫到了 X 个候选文件、识别出 Y 个 cron"——
// 当 X>0 而 Y=0 时能立刻看出是 cron 解析问题而不是路径问题。
func countSubscriptionScriptFiles(scriptsDir string, allowedExts map[string]bool, sub *model.Subscription) int {
	if _, err := os.Stat(scriptsDir); err != nil {
		return 0
	}
	count := 0
	filepath.Walk(scriptsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			switch strings.ToLower(info.Name()) {
			case ".git", "node_modules", "__pycache__":
				return filepath.SkipDir
			}
			return nil
		}
		relPath := subscriptionRelativeScriptPath(scriptsDir, path, info)
		if shouldManageSubscriptionFile(sub, relPath, allowedExts) {
			count++
		}
		return nil
	})
	return count
}

// FallbackSubscriptionCron 是订阅脚本未声明 cron 时使用的"硬兜底"。
// 用户既没在脚本头部写 cron 注释、也没在系统设置 default_cron_rule 里配自定义默认值时，
// 用这个兜底——每天 0 点跑一次，保证 git 拉到的脚本都会变成定时任务。
// 用户可以在任务详情里手动改 cron，或者把脚本注释加上 cron 头让下次同步用真值覆盖。
const FallbackSubscriptionCron = "0 0 * * *"

func getSubscriptionTaskSyncOptions(sub *model.Subscription) subscriptionTaskSyncOptions {
	defaultCron := strings.TrimSpace(model.GetRegisteredConfig("default_cron_rule"))
	if defaultCron != "" && !cron.Parse(defaultCron).Valid {
		defaultCron = ""
	}
	// 系统设置里 default_cron_rule 是空时，落到硬兜底。这是用户"git 拉了但一个任务都没建"
	// 困惑的根因：原默认是 "" → cron 头没识别就 skip，整个仓库一个任务都建不出来。
	// v2.2.10 起改为：默认兜底 = 每天 0 点。用户想关闭兜底，可以把 default_cron_rule
	// 设成非法值（比如 "off"），代码会回退到 "" 然后跳过没 cron 的脚本。
	if defaultCron == "" {
		defaultCron = FallbackSubscriptionCron
	}

	return subscriptionTaskSyncOptions{
		autoAdd:     sub.AutoAddTask || isConfigEnabled("auto_add_cron", true),
		autoDelete:  sub.AutoDelTask || isConfigEnabled("auto_del_cron", true),
		defaultCron: defaultCron,
		allowedExts: getSubscriptionAllowedExtensions(model.GetRegisteredConfig("repo_file_extensions")),
	}
}

func isConfigEnabled(key string, defaultValue bool) bool {
	if _, exists := model.GetSystemConfigDefinition(key); exists {
		return model.GetRegisteredConfigBool(key)
	}
	return model.GetConfigBool(key, defaultValue)
}

func getSubscriptionAllowedExtensions(raw string) map[string]bool {
	exts := make(map[string]bool)
	for _, token := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	}) {
		token = strings.TrimSpace(strings.ToLower(token))
		token = strings.TrimPrefix(token, "*")
		if token == "" {
			continue
		}
		if !strings.HasPrefix(token, ".") {
			token = "." + token
		}
		exts[token] = true
	}
	if len(exts) > 0 {
		return exts
	}

	return map[string]bool{
		".js":  true,
		".mjs": true,
		".ts":  true,
		".py":  true,
		".sh":  true,
	}
}

// subscriptionHelperScriptNames 列出"通知辅助脚本"——这些脚本本身不是定时任务，
// 而是被业务脚本 require/import 调用的工具。订阅同步时不应该为它们建定时任务，
// 即使没有 cron 头并且系统配置了 default_cron_rule 兜底也不建。
// 名字按"去掉扩展名后的 basename，小写"匹配。
var subscriptionHelperScriptNames = map[string]bool{
	"sendnotify":  true, // QLScriptPublic / jdpro 风格的通知 helper（多种大小写拼写都收）
	"sendnofity":  true, // 实际仓库里 sendNofity.js 这种笔误也常见
	"notify":      true, // 青龙原版 notify.py
	"sendnotify_": true, // sendNotify_.js 这种带下划线后缀的变体
	"jdcookie":    true,
	"ql":          true,
	"qlapi":       true,
	"utils":       true,
	"util":        true,
	"common":      true,
	"helper":      true,
	"sign":        true, // 通用签名 helper
	"magic":       true, // jd_magic 类
	"jsencrypt":   true,
	"cryptojs":    true,
}

// isSubscriptionHelperScript 判断"该脚本是不是被业务脚本调用的辅助脚本"。
// 注意：只在脚本本身没有 cron 头注释时才用——脚本明确写了 cron 表达式
// 视为用户主动声明"这是定时任务"，必须建。
func isSubscriptionHelperScript(filename string) bool {
	base := strings.ToLower(strings.TrimSuffix(filename, filepath.Ext(filename)))
	return subscriptionHelperScriptNames[base]
}

func subscriptionRelativeScriptPath(root, path string, info os.FileInfo) string {
	if rel, err := filepath.Rel(root, path); err == nil && rel != "" && rel != "." {
		return rel
	}
	if info != nil {
		return info.Name()
	}
	return filepath.Base(path)
}

func shouldManageSubscriptionFile(sub *model.Subscription, filePath string, allowedExts map[string]bool) bool {
	ext := strings.ToLower(filepath.Ext(filePath))
	if !allowedExts[ext] {
		return false
	}
	return matchesSubscriptionFilters(sub, filePath)
}

func collectSubscriptionTaskCandidates(sub *model.Subscription, options subscriptionTaskSyncOptions) map[string]subscriptionTaskCandidate {
	candidates := make(map[string]subscriptionTaskCandidate)
	saveDir := subscriptionSaveDir(sub)
	scriptsDir := filepath.Join(config.C.Data.ScriptsDir, saveDir)

	if _, err := os.Stat(scriptsDir); err != nil {
		return candidates
	}

	// 收集"所有受支持扩展名的文件"。用 walk + 兜底的 ReadDir，确保:
	// 1) 子目录里的脚本能扫到（用 walk）
	// 2) 即使 walk 在某些挂载卷（NAS / Android Magisk 容器）下 readdir 异常返回 0，
	//    至少根目录平铺扫一遍兜底
	type fileEntry struct {
		path    string
		relPath string
		info    os.FileInfo
	}
	var allFiles []fileEntry
	seen := map[string]bool{}

	addEntry := func(path string, info os.FileInfo) {
		if info == nil || info.IsDir() {
			return
		}
		ext := strings.ToLower(filepath.Ext(info.Name()))
		if !options.allowedExts[ext] {
			return
		}
		if seen[path] {
			return
		}
		seen[path] = true
		allFiles = append(allFiles, fileEntry{
			path:    path,
			relPath: subscriptionRelativeScriptPath(scriptsDir, path, info),
			info:    info,
		})
	}

	filepath.Walk(scriptsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			switch strings.ToLower(info.Name()) {
			case ".git", "node_modules", "__pycache__":
				return filepath.SkipDir
			}
			return nil
		}
		addEntry(path, info)
		return nil
	})

	// 兜底：walk 一个文件都没拿到，平铺扫根目录（不递归）
	if len(allFiles) == 0 {
		entries, _ := os.ReadDir(scriptsDir)
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			fullPath := filepath.Join(scriptsDir, entry.Name())
			info, err := entry.Info()
			if err != nil {
				if stat, statErr := os.Stat(fullPath); statErr == nil {
					info = stat
				} else {
					continue
				}
			}
			addEntry(fullPath, info)
		}
	}

	// 兜底 #2：白/黑名单填错了导致全部被过滤 → 自动忽略过滤规则
	effectiveSub := sub
	if (sub.Whitelist != "" || sub.Blacklist != "") && len(allFiles) > 0 {
		matchedCount := 0
		for _, f := range allFiles {
			if matchesSubscriptionFilters(sub, f.relPath) {
				matchedCount++
			}
		}
		if matchedCount == 0 && hasNonWildcardSubscriptionFilter(sub.Whitelist) {
			fallback := *sub
			fallback.Whitelist = ""
			fallback.Blacklist = ""
			effectiveSub = &fallback
		}
	}

	for _, f := range allFiles {
		path := f.path
		info := f.info

		if !shouldManageSubscriptionFile(effectiveSub, f.relPath, options.allowedExts) {
			continue
		}

		// 先尝试从脚本头部识别 cron。脚本明确写了 cron 就完全按它来。
		cronExpr := resolveCronForSubscriptionTask(path, "")
		if cronExpr == "" {
			// 脚本头没 cron 注释。两种处理：
			//   1) 已知是通知/工具辅助脚本（sendNotify.js / notify.py 等）→ 不建任务
			//   2) 否则用兜底 cron（系统配置 default_cron_rule，或硬兜底每天 0 点）
			//      —— 保证 git 拉到的业务脚本必定变成任务，不会"明明拉成功但任务列表空"
			if isSubscriptionHelperScript(info.Name()) {
				continue
			}
			cronExpr = options.defaultCron
			if cronExpr == "" {
				continue
			}
		}

		relPath, err := filepath.Rel(config.C.Data.ScriptsDir, path)
		if err != nil {
			continue
		}
		command := "task " + relPath
		taskName := resolveSubscriptionTaskName(path, strings.TrimSuffix(info.Name(), filepath.Ext(info.Name())))
		candidates[command] = subscriptionTaskCandidate{
			Name:           taskName,
			Command:        command,
			CronExpression: cronExpr,
		}
	}

	return candidates
}

func queryTasksByLabel(label string) *gorm.DB {
	return database.DB.Where(
		"labels = ? OR labels LIKE ? OR labels LIKE ? OR labels LIKE ?",
		label,
		label+",%",
		"%,"+label,
		"%,"+label+",%",
	)
}

func resolveCronForSubscriptionTask(path string, defaultCron string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineCount := 0
	scriptBase := strings.ToLower(filepath.Base(path))
	for scanner.Scan() {
		lineCount++
		if lineCount > 50 {
			break
		}
		line := scanner.Text()
		if expr := extractSubscriptionCronExpression(line, scriptBase); expr != "" {
			return expr
		}
	}
	return strings.TrimSpace(defaultCron)
}

func resolveSubscriptionTaskName(path, fallback string) string {
	fallback = strings.TrimSpace(fallback)

	f, err := os.Open(path)
	if err != nil {
		return fallback
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineCount := 0
	for scanner.Scan() {
		lineCount++
		if lineCount > 120 {
			break
		}

		if matches := subscriptionTaskNameRe.FindStringSubmatch(scanner.Text()); len(matches) > 1 {
			name := strings.TrimSpace(matches[1])
			if name != "" {
				return name
			}
		}
	}

	return fallback
}

func extractSubscriptionCronExpression(line, scriptBase string) string {
	if expr := extractSubscriptionCronExpressionFromLabel(line); expr != "" {
		return expr
	}

	if matches := cronDirectiveLineRe.FindStringSubmatch(line); len(matches) > 2 && scriptBase != "" {
		expr := strings.TrimSpace(matches[1])
		fileToken := normalizeSubscriptionCronScriptToken(matches[2])
		if fileToken != "" &&
			strings.EqualFold(filepath.Base(fileToken), scriptBase) &&
			cron.Parse(expr).Valid {
			return expr
		}
	}

	return extractSubscriptionCronExpressionFromFilenameLine(line, scriptBase)
}

// extractSubscriptionCronExpressionFromLabel 处理“cron”标签开头的行，
// 兼容 `cron:`、`cron`（无冒号）、JSDoc `* cron`、`@cron:` 等多种写法。
// 当行尾跟随文件名提示（例如 `cron 8 10 * * *  qtx.js`）时，只截取前 5 或 6 个字段做 cron。
func extractSubscriptionCronExpressionFromLabel(line string) string {
	matches := cronLabelPrefixRe.FindStringSubmatch(line)
	if len(matches) < 2 {
		return ""
	}
	rest := strings.TrimSpace(matches[1])
	if rest == "" {
		return ""
	}

	if cron.Parse(rest).Valid {
		return rest
	}

	fields := strings.Fields(rest)
	for _, cnt := range []int{6, 5} {
		if len(fields) < cnt {
			continue
		}
		expr := strings.Join(fields[:cnt], " ")
		if cron.Parse(expr).Valid {
			return expr
		}
	}
	return ""
}

func extractSubscriptionCronExpressionFromFilenameLine(line, scriptBase string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || scriptBase == "" {
		return ""
	}

	cleaned := strings.TrimSpace(strings.Trim(trimmed, `"'`))
	fields := strings.Fields(cleaned)
	if len(fields) < 6 {
		return ""
	}

	for _, cronFieldCount := range []int{6, 5} {
		if len(fields) <= cronFieldCount {
			continue
		}

		expr := strings.Join(fields[:cronFieldCount], " ")
		if !cron.Parse(expr).Valid {
			continue
		}

		fileToken := normalizeSubscriptionCronScriptToken(fields[cronFieldCount])
		if fileToken == "" {
			continue
		}

		if strings.EqualFold(filepath.Base(fileToken), scriptBase) {
			return expr
		}
	}

	return ""
}

func normalizeSubscriptionCronScriptToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.Trim(token, `"'`)
	token = strings.TrimRight(token, ",;:)")
	token = strings.TrimLeft(token, "(")
	return strings.TrimSpace(token)
}
