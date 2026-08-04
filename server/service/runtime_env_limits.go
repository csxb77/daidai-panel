package service

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
)

// Linux 上 "[Errno 7] Argument list too long"（E2BIG）只可能来自 execve 的两道墙：
//
//  1. MAX_ARG_STRLEN = PAGE_SIZE * 32 = 128 KiB，限制**单个** argv/envp 字符串。
//     一条 "KEY=VALUE\0" 只要超过它，任何 exec 都会失败，和环境总量无关。
//  2. argv+envp 的**总大小**，内核取 min(_STK_LIM/4*3, RLIMIT_STACK/4)，
//     默认 8 MiB 栈下约等于 2 MiB。
//
// 面板自己 exec 脚本时撞不上这两堵墙：任务变量走 env 文件传递，真实进程环境
// （buildBootstrapProcessEnv）只有 PATH/HOME/TZ 等十来个键。但 Python / Node / Go
// 的 bootstrap 会把 env 文件里的变量**全量还原**进 os.environ / process.env，
// 脚本随后自己 spawn 子进程（subprocess、child_process、直接调 node/python）时，
// 子进程会继承这份巨大的环境 —— 墙是在脚本内部才被撞破的。
//
// 结果就是用户只看到脚本自己抛出的 "[Errno 7]"，完全定位不到面板，也想不到
// 「面板能跑起来，但脚本一开子进程就炸」这种反直觉现象。所以这里在启动脚本之前
// 就把风险摊开写进任务日志。
const (
	// linuxMaxArgStrLenBytes 对应内核的 MAX_ARG_STRLEN。
	// 口径与 copy_strings 一致：统计 "KEY=VALUE" 再加结尾 NUL。
	linuxMaxArgStrLenBytes = 128 * 1024
	// linuxTypicalArgMaxBytes 是默认 8 MiB 栈下 argv+envp 的实际总上限。
	// 真实值取 RLIMIT_STACK/4，这里只用于提示，不做精确判定。
	linuxTypicalArgMaxBytes = 2 * 1024 * 1024
	// linuxArgMaxWarnBytes 是总量提示阈值：到 75% 就提醒，别等真炸了才说。
	linuxArgMaxWarnBytes = linuxTypicalArgMaxBytes / 4 * 3
)

const runtimeEnvWarningPrefix = "[环境变量告警] "

// runtimeEnvEntrySize 记录一条环境变量在 execve 里实际占用的字节数。
type runtimeEnvEntrySize struct {
	Name  string
	Bytes int
}

// runtimeEnvSizeReport 是一次任务环境的体检结果。
type runtimeEnvSizeReport struct {
	// TotalBytes 是所有变量按 execve 口径累加的字节数。
	TotalBytes int
	// Oversized 是单条就超过 MAX_ARG_STRLEN 的变量，按大小降序。
	Oversized []runtimeEnvEntrySize
	// Largest 是最大的一条，用于总量超标时给出线索。
	Largest runtimeEnvEntrySize
}

// runtimeEnvEntryBytes 返回一条 envp 字符串的真实长度：len("KEY=VALUE") + 1（结尾 NUL）。
func runtimeEnvEntryBytes(name, value string) int {
	return len(name) + 1 + len(value) + 1
}

func inspectRuntimeEnvSize(envVars map[string]string) runtimeEnvSizeReport {
	report := runtimeEnvSizeReport{}
	for name, value := range envVars {
		entry := runtimeEnvEntrySize{Name: name, Bytes: runtimeEnvEntryBytes(name, value)}
		report.TotalBytes += entry.Bytes
		if entry.Bytes > report.Largest.Bytes ||
			(entry.Bytes == report.Largest.Bytes && entry.Name < report.Largest.Name) {
			report.Largest = entry
		}
		if entry.Bytes > linuxMaxArgStrLenBytes {
			report.Oversized = append(report.Oversized, entry)
		}
	}
	sortRuntimeEnvEntries(report.Oversized)
	return report
}

func sortRuntimeEnvEntries(entries []runtimeEnvEntrySize) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Bytes != entries[j].Bytes {
			return entries[i].Bytes > entries[j].Bytes
		}
		return entries[i].Name < entries[j].Name
	})
}

// buildRuntimeEnvLimitWarnings 产出可直接写进任务日志的提示行（不带结尾换行）。
// interpreter 用来区分两种完全不同的后果：
//   - bash：面板已经不会 export 超限变量，脚本自己读得到，但子进程读不到（静默为空）
//   - 其它：变量会完整进入 os.environ / process.env，子进程 exec 时直接 E2BIG
func buildRuntimeEnvLimitWarnings(envVars map[string]string, interpreter string) []string {
	if len(envVars) == 0 {
		return nil
	}

	isShell := strings.TrimSpace(interpreter) == "bash"
	report := inspectRuntimeEnvSize(envVars)
	lines := make([]string, 0, 8)

	if len(report.Oversized) > 0 {
		lines = append(lines, fmt.Sprintf(
			"检测到 %d 条环境变量超过 Linux 单个环境变量上限 %s（MAX_ARG_STRLEN = PAGE_SIZE * 32）：",
			len(report.Oversized), formatEnvByteSize(linuxMaxArgStrLenBytes)))
		for _, entry := range report.Oversized {
			lines = append(lines, fmt.Sprintf("  %s = %s", entry.Name, formatEnvByteSize(entry.Bytes)))
		}
		if isShell {
			lines = append(lines,
				"bash 任务里这类变量只会作为普通 shell 变量存在、不会 export，脚本内 $变量 仍然读得到，",
				"但脚本启动的子进程（node / python 等）不会继承到它，在子进程里取值为空。")
		} else {
			lines = append(lines,
				"面板通过 env 文件注入，脚本自身读取不受影响；但脚本内再启动子进程时（Python subprocess、",
				"Node child_process、或脚本里直接调 node / python），子进程会继承这条超长变量，",
				`execve 立即失败并报 "Argument list too long"（errno 7 / E2BIG）。`,
				"这就是「面板能把脚本跑起来，脚本一开子进程就炸」的原因。")
		}
		lines = append(lines,
			"处理建议：把账号拆成多条同名环境变量或多个变量名；用 `task 脚本 desi 变量名 1-20` /",
			"`task 脚本 conc 变量名` 按账号分批执行；或改用文件传递（变量里只放文件路径）。")
	}

	// bash 的导出总量本来就被 shellEnvExportBudgetBytes 卡住，不会撞 ARG_MAX，
	// 这里再提总量只会变成误报，所以只对其它解释器提示。
	if !isShell && report.TotalBytes >= linuxArgMaxWarnBytes {
		lines = append(lines, fmt.Sprintf(
			"任务环境变量合计 %s，已接近 Linux execve 参数总上限（约 %s，实际取 RLIMIT_STACK/4）。",
			formatEnvByteSize(report.TotalBytes), formatEnvByteSize(linuxTypicalArgMaxBytes)))
		if report.Largest.Name != "" {
			lines = append(lines, fmt.Sprintf(
				`脚本内启动子进程时可能报 "Argument list too long"（errno 7 / E2BIG）。最大的一条是 %s（%s）。`,
				report.Largest.Name, formatEnvByteSize(report.Largest.Bytes)))
		}
		lines = append(lines, "处理建议：在「环境变量」页禁用或清理任务用不到的变量。")
	}

	if isShell {
		if skipped := shellEnvExportSkippedByBudget(envVars); len(skipped) > 0 {
			lines = append(lines, fmt.Sprintf(
				"另有 %d 条环境变量因为导出总量超过 %s 未被 export，bash 任务的子进程读不到它们：",
				len(skipped), formatEnvByteSize(shellEnvExportBudgetBytes)))
			for _, entry := range skipped {
				lines = append(lines, fmt.Sprintf("  %s = %s", entry.Name, formatEnvByteSize(entry.Bytes)))
			}
		}
	}

	if len(lines) == 0 {
		return nil
	}

	prefixed := make([]string, 0, len(lines))
	for _, line := range lines {
		prefixed = append(prefixed, runtimeEnvWarningPrefix+line)
	}
	return prefixed
}

// emitRuntimeEnvLimitWarnings 把提示写进任务日志。
// Windows 没有 MAX_ARG_STRLEN / ARG_MAX 这套限制，直接跳过，避免误报。
func emitRuntimeEnvLimitWarnings(envVars map[string]string, interpreter string, emit func(line string)) {
	if emit == nil || runtime.GOOS == "windows" {
		return
	}
	for _, line := range buildRuntimeEnvLimitWarnings(envVars, interpreter) {
		emit(line)
	}
}

func formatEnvByteSize(size int) string {
	switch {
	case size >= 1024*1024:
		return fmt.Sprintf("%.1f MB", float64(size)/(1024*1024))
	case size >= 1024:
		return fmt.Sprintf("%.1f KB", float64(size)/1024)
	default:
		return fmt.Sprintf("%d B", size)
	}
}
