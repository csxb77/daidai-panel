package service

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
)

// buildEnvWithTotalBytes 造一个「按 execve 口径合计正好 total 字节」的环境，
// 用来卡总量阈值的边界。count 要足够大，保证每条都不会自己撞上 MAX_ARG_STRLEN。
func buildEnvWithTotalBytes(count, total int) map[string]string {
	env := make(map[string]string, count)
	remaining := total
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("V%02d", i)
		overhead := len(name) + 2
		share := remaining / (count - i)
		if share < overhead {
			share = overhead
		}
		env[name] = strings.Repeat("x", share-overhead)
		remaining -= share
	}
	return env
}

func envValueForEntryBytes(name string, entryBytes int) string {
	return strings.Repeat("c", entryBytes-len(name)-2)
}

func joinWarnings(lines []string) string {
	return strings.Join(lines, "\n")
}

func TestRuntimeEnvEntryBytesMatchesExecveAccounting(t *testing.T) {
	// execve 的 copy_strings 统计的是 "KEY=VALUE" 加结尾 NUL。
	if got, want := runtimeEnvEntryBytes("AB", "cde"), len("AB=cde")+1; got != want {
		t.Fatalf("expected entry bytes %d, got %d", want, got)
	}
}

func TestInspectRuntimeEnvSizeReportsTotalAndLargest(t *testing.T) {
	report := inspectRuntimeEnvSize(map[string]string{
		"A":  "1",
		"BB": "2222",
	})

	want := runtimeEnvEntryBytes("A", "1") + runtimeEnvEntryBytes("BB", "2222")
	if report.TotalBytes != want {
		t.Fatalf("expected total %d, got %d", want, report.TotalBytes)
	}
	if report.Largest.Name != "BB" {
		t.Fatalf("expected largest BB, got %q", report.Largest.Name)
	}
	if len(report.Oversized) != 0 {
		t.Fatalf("expected no oversized entries, got %#v", report.Oversized)
	}
}

func TestBuildRuntimeEnvLimitWarningsQuietForSmallEnv(t *testing.T) {
	if lines := buildRuntimeEnvLimitWarnings(map[string]string{"JD_COOKIE": "pt_key=a"}, "python3"); len(lines) != 0 {
		t.Fatalf("expected no warnings for a small env, got %#v", lines)
	}
	if lines := buildRuntimeEnvLimitWarnings(nil, "python3"); len(lines) != 0 {
		t.Fatalf("expected no warnings for empty env, got %#v", lines)
	}
}

func TestBuildRuntimeEnvLimitWarningsAtExactMaxArgStrLen(t *testing.T) {
	// 正好 MAX_ARG_STRLEN（含结尾 NUL）仍然能 exec，不该报警。
	env := map[string]string{
		"JD_COOKIE": envValueForEntryBytes("JD_COOKIE", linuxMaxArgStrLenBytes),
	}
	if got := runtimeEnvEntryBytes("JD_COOKIE", env["JD_COOKIE"]); got != linuxMaxArgStrLenBytes {
		t.Fatalf("test fixture wrong: entry bytes %d", got)
	}

	if lines := buildRuntimeEnvLimitWarnings(env, "python3"); len(lines) != 0 {
		t.Fatalf("expected no warning at exactly MAX_ARG_STRLEN, got:\n%s", joinWarnings(lines))
	}
}

func TestBuildRuntimeEnvLimitWarningsJustOverMaxArgStrLen(t *testing.T) {
	env := map[string]string{
		"JD_COOKIE": envValueForEntryBytes("JD_COOKIE", linuxMaxArgStrLenBytes+1),
	}

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "python3"))
	if text == "" {
		t.Fatal("expected a warning one byte over MAX_ARG_STRLEN")
	}
	for _, marker := range []string{
		runtimeEnvWarningPrefix,
		"JD_COOKIE",
		"Argument list too long",
		"errno 7",
		"E2BIG",
		"子进程",
	} {
		if !strings.Contains(text, marker) {
			t.Fatalf("expected warning to mention %q, got:\n%s", marker, text)
		}
	}
}

func TestBuildRuntimeEnvLimitWarningsListsEveryOversizedVariable(t *testing.T) {
	env := map[string]string{
		"SMALL":   "ok",
		"BIG_ONE": envValueForEntryBytes("BIG_ONE", linuxMaxArgStrLenBytes+1),
		"BIG_TWO": envValueForEntryBytes("BIG_TWO", linuxMaxArgStrLenBytes+2048),
	}

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "node"))
	if !strings.Contains(text, "BIG_ONE") || !strings.Contains(text, "BIG_TWO") {
		t.Fatalf("expected both oversized names, got:\n%s", text)
	}
	if strings.Contains(text, "SMALL =") {
		t.Fatalf("expected small variable to be left out, got:\n%s", text)
	}
	// 按体积降序，最大的先说。
	if strings.Index(text, "BIG_TWO") > strings.Index(text, "BIG_ONE") {
		t.Fatalf("expected larger variable listed first, got:\n%s", text)
	}
}

func TestBuildRuntimeEnvLimitWarningsShellVariantDoesNotClaimExecFailure(t *testing.T) {
	// bash 任务里超限变量只赋值不 export，不会 E2BIG，只会让子进程读不到，
	// 提示必须说清这个差别，不能照抄 Python/Node 的说法。
	env := map[string]string{
		"JD_COOKIE": envValueForEntryBytes("JD_COOKIE", linuxMaxArgStrLenBytes+1),
	}

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "bash"))
	if !strings.Contains(text, "JD_COOKIE") {
		t.Fatalf("expected shell warning to mention the variable, got:\n%s", text)
	}
	if strings.Contains(text, "Argument list too long") {
		t.Fatalf("shell tasks never hit E2BIG from panel env, warning must not claim it:\n%s", text)
	}
	if !strings.Contains(text, "export") {
		t.Fatalf("expected shell warning to explain the export behaviour, got:\n%s", text)
	}
}

func TestBuildRuntimeEnvLimitWarningsTotalNearArgMax(t *testing.T) {
	env := buildEnvWithTotalBytes(20, linuxArgMaxWarnBytes)
	report := inspectRuntimeEnvSize(env)
	if report.TotalBytes != linuxArgMaxWarnBytes {
		t.Fatalf("test fixture wrong: total %d", report.TotalBytes)
	}
	if len(report.Oversized) != 0 {
		t.Fatalf("test fixture wrong: single entries must stay under MAX_ARG_STRLEN, got %#v", report.Oversized)
	}

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "python3"))
	if !strings.Contains(text, "RLIMIT_STACK/4") {
		t.Fatalf("expected total-size warning, got:\n%s", text)
	}
	if !strings.Contains(text, "errno 7") {
		t.Fatalf("expected total-size warning to name the errno, got:\n%s", text)
	}
}

func TestBuildRuntimeEnvLimitWarningsTotalJustUnderThreshold(t *testing.T) {
	env := buildEnvWithTotalBytes(20, linuxArgMaxWarnBytes-1)
	if got := inspectRuntimeEnvSize(env).TotalBytes; got != linuxArgMaxWarnBytes-1 {
		t.Fatalf("test fixture wrong: total %d", got)
	}

	if lines := buildRuntimeEnvLimitWarnings(env, "python3"); len(lines) != 0 {
		t.Fatalf("expected silence one byte below the threshold, got:\n%s", joinWarnings(lines))
	}
}

func TestBuildRuntimeEnvLimitWarningsSkipsTotalSizeForShell(t *testing.T) {
	// bash 的导出量被 shellEnvExportBudgetBytes 卡死，报总量只会是误报。
	env := buildEnvWithTotalBytes(20, linuxArgMaxWarnBytes)

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "bash"))
	if strings.Contains(text, "RLIMIT_STACK/4") {
		t.Fatalf("shell tasks must not get the ARG_MAX total warning, got:\n%s", text)
	}
}

func TestBuildRuntimeEnvLimitWarningsReportsShellExportBudgetDrops(t *testing.T) {
	env := buildEnvWithTotalBytes(10, shellEnvExportBudgetBytes*2)
	skipped := shellEnvExportSkippedByBudget(env)
	if len(skipped) == 0 {
		t.Fatalf("test fixture wrong: expected some variables to lose the export budget")
	}

	text := joinWarnings(buildRuntimeEnvLimitWarnings(env, "bash"))
	if !strings.Contains(text, "未被 export") {
		t.Fatalf("expected shell export-budget warning, got:\n%s", text)
	}
	if !strings.Contains(text, skipped[0].Name) {
		t.Fatalf("expected dropped variable %q to be listed, got:\n%s", skipped[0].Name, text)
	}
}

func TestPlanShellEnvExportMatchesWriterRules(t *testing.T) {
	env := map[string]string{
		"OK":              "value",
		"LD_PRELOAD":      "/tmp/evil.so",
		"bad-name":        "value",
		"WITH_NUL":        "a\x00b",
		"TOO_LONG":        envValueForEntryBytes("TOO_LONG", shellEnvExportValueMaxBytes+1),
		"EXACT_MAX_VALUE": envValueForEntryBytes("EXACT_MAX_VALUE", shellEnvExportValueMaxBytes),
	}

	plan := planShellEnvExport(env)
	exported := strings.Join(plan.Exported, ",")
	if !strings.Contains(exported, "OK") {
		t.Fatalf("expected OK exported, got %q", exported)
	}
	if !strings.Contains(exported, "EXACT_MAX_VALUE") {
		t.Fatalf("expected value at exactly the cap to still export, got %q", exported)
	}
	for _, name := range []string{"LD_PRELOAD", "bad-name", "WITH_NUL", "TOO_LONG"} {
		if strings.Contains(exported, name) {
			t.Fatalf("expected %s to stay unexported, got %q", name, exported)
		}
	}
	if len(plan.SkippedTooLong) != 1 || plan.SkippedTooLong[0].Name != "TOO_LONG" {
		t.Fatalf("expected TOO_LONG recorded as oversized, got %#v", plan.SkippedTooLong)
	}
	if len(plan.SkippedBudget) != 0 {
		t.Fatalf("expected no budget drops here, got %#v", plan.SkippedBudget)
	}
}

func TestPlanShellEnvExportStopsAtBudget(t *testing.T) {
	env := buildEnvWithTotalBytes(10, shellEnvExportBudgetBytes*2)

	plan := planShellEnvExport(env)
	if len(plan.Exported) == 0 {
		t.Fatal("expected the first variables to still export")
	}
	if len(plan.SkippedBudget) == 0 {
		t.Fatal("expected later variables to lose the budget")
	}

	exportedBytes := 0
	for _, name := range plan.Exported {
		exportedBytes += runtimeEnvEntryBytes(name, env[name])
	}
	if exportedBytes > shellEnvExportBudgetBytes {
		t.Fatalf("exported %d bytes, over budget %d", exportedBytes, shellEnvExportBudgetBytes)
	}
}

func TestEmitRuntimeEnvLimitWarningsFollowsPlatform(t *testing.T) {
	env := map[string]string{
		"JD_COOKIE": envValueForEntryBytes("JD_COOKIE", linuxMaxArgStrLenBytes+1),
	}

	var lines []string
	emitRuntimeEnvLimitWarnings(env, "python3", func(line string) {
		lines = append(lines, line)
	})

	if runtime.GOOS == "windows" {
		// Windows 没有 MAX_ARG_STRLEN / ARG_MAX 这套限制，提示只会是噪音。
		if len(lines) != 0 {
			t.Fatalf("expected no warnings on windows, got:\n%s", joinWarnings(lines))
		}
		return
	}
	if len(lines) == 0 {
		t.Fatal("expected warnings to be emitted on unix")
	}
}

func TestEmitRuntimeEnvLimitWarningsToleratesNilSink(t *testing.T) {
	emitRuntimeEnvLimitWarnings(map[string]string{"A": "b"}, "python3", nil)
}
