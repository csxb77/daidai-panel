package handler

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMagiskServiceScriptExportsAndroidRuntimeEnv(t *testing.T) {
	scriptPath := filepath.Join("..", "..", "Magisk", "service.sh")
	data, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read Magisk service.sh: %v", err)
	}
	text := string(data)

	requiredSnippets := []string{
		"export DAIDAI_MAGISK_MODULE=1",
		"export DAIDAI_ANDROID_RUNTIME_BIN_DIR=/data/adb/daidai-panel/bin",
		"/data/adb/daidai-panel/bin/python/bin",
		"/data/adb/daidai-panel/bin/node/bin",
	}
	for _, snippet := range requiredSnippets {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected service.sh to contain %q", snippet)
		}
	}

	if strings.Contains(text, `deps/python/3.12`) {
		t.Fatal("expected service.sh to avoid hard-coded deps/python/3.12 venv path")
	}
	for _, snippet := range []string{
		`PY_MINOR=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"`,
		`export DAIDAI_PYTHON_VERSION="$PY_MINOR"`,
		`"$DAIDAI_DIR/deps/python/$PY_MINOR"`,
	} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected service.sh to contain dynamic python runtime snippet %q", snippet)
		}
	}
}

// 下面这几个针对 customize.sh 的断言都是纯静态字符串检查。
// 它们只能防止相应改动被整段删掉 / 改回旧写法，**防不住逻辑写错**，
// 也不构成"Magisk 模块有测试覆盖"。真正的验证只能靠真机安装。
func readMagiskCustomizeScript(t *testing.T) string {
	t.Helper()
	scriptPath := filepath.Join("..", "..", "Magisk", "customize.sh")
	data, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read Magisk customize.sh: %v", err)
	}
	return string(data)
}

// 安装期失败必须真的失败：rurima 前置检查 / 依赖装完再验证 / 成功提示有条件。
func TestMagiskCustomizeScriptFailsLoudlyOnInstallErrors(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	requiredSnippets := []string{
		// rurima 存在性 + 可执行性检查，必须在第一次调用它之前
		`RURIMA="$MODPATH/system/bin/rurima"`,
		`if [ ! -f "$RURIMA" ]; then`,
		`if [ ! -x "$RURIMA" ]; then`,
		// 装完再验证关键运行时（apk add 可能部分成功，只信退出码不可靠）
		`for c in python3 node npm git bash; do`,
		`missing_runtimes`,
		// 成功提示的开关
		`INSTALL_DEPS_OK=1`,
		`if [ "$INSTALL_DEPS_OK" != "1" ]; then`,
		// abort 时告知用户备份仍在
		`warn_backup_preserved`,
	}
	for _, snippet := range requiredSnippets {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected customize.sh to contain %q", snippet)
		}
	}

	// 依赖验证必须排在 apk 安装之后，否则验的是空容器
	apkIdx := strings.Index(text, "apk add --no-cache")
	verifyIdx := strings.Index(text, `missing_runtimes=""`)
	if apkIdx < 0 || verifyIdx < 0 {
		t.Fatalf("customize.sh 缺少 apk 安装段或运行时验证段 (apk=%d verify=%d)", apkIdx, verifyIdx)
	}
	if verifyIdx < apkIdx {
		t.Fatal("运行时验证必须放在 apk 安装之后")
	}

	// 「安装完成！」必须排在 INSTALL_DEPS_OK 判断之后
	gateIdx := strings.Index(text, `if [ "$INSTALL_DEPS_OK" != "1" ]; then`)
	doneIdx := strings.Index(text, "- 安装完成！")
	if gateIdx < 0 || doneIdx < 0 {
		t.Fatalf("customize.sh 缺少成功提示或其开关 (gate=%d done=%d)", gateIdx, doneIdx)
	}
	if doneIdx < gateIdx {
		t.Fatal("「安装完成！」必须排在 INSTALL_DEPS_OK 判断之后，不能无条件打印")
	}
}

// 装依赖那段 heredoc 内不得使用 set -e：
// 其中的离线包 `apk add --no-network` 本来就允许失败（后面有联网兜底），
// 加了 set -e 会让整个安装在这一句直接中断。
func TestMagiskCustomizeScriptDependencyHeredocHasNoSetE(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	start := strings.Index(text, "/bin/ash << 'EOF'")
	if start < 0 {
		t.Fatal("customize.sh 找不到装依赖的 heredoc 起始标记")
	}
	rest := text[start:]
	end := strings.Index(rest, "\nEOF")
	if end < 0 {
		t.Fatal("customize.sh 找不到装依赖 heredoc 的结束标记")
	}
	if block := rest[:end]; strings.Contains(block, "set -e") {
		t.Fatal("装依赖的 heredoc 内不得使用 set -e：离线包 apk add --no-network 允许失败，set -e 会直接中断安装")
	}
}

// 架构闸门只放行 arm64；容器运行时 rurima 只有 aarch64 构建。
func TestMagiskCustomizeScriptRejectsX64(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	if strings.Contains(text, `[ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]`) {
		t.Fatal("customize.sh 不得再放行 x64：rurima 只有 aarch64 构建，x86_64 会在 exec 时失败")
	}
	if !strings.Contains(text, `if [ "$ARCH" != "arm64" ]; then`) {
		t.Fatal("customize.sh 架构检查应只放行 arm64")
	}
	// x64 要有专门的提示，不能和「架构不支持」混为一谈
	if !strings.Contains(text, `if [ "$ARCH" = "x64" ] || [ "$ARCH" = "x86_64" ]; then`) {
		t.Fatal("customize.sh 应对 x86_64 给出专门的提示分支")
	}
	// x86_64 的 Alpine rootfs 分支已经是死代码，不应残留
	if strings.Contains(text, "alpine-minirootfs-3.18.9-x86_64.tar.gz") {
		t.Fatal("customize.sh 不应再保留 x86_64 的 Alpine rootfs 下载分支")
	}
}

// 硬性 API 闸门降到 23（Android 6.0）；真正的准入是容器能力探测。
func TestMagiskCustomizeScriptUsesCapabilityProbeInsteadOfVersionGate(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	if strings.Contains(text, `if [ "$API" -lt 24 ]; then`) {
		t.Fatal("customize.sh 的硬性 API 闸门应从 24 降到 23")
	}
	if !strings.Contains(text, `if [ "$API" -lt 23 ]; then`) {
		t.Fatal("customize.sh 应保留 API 23 的硬性下限")
	}

	// 能力探测：哨兵字符串 + 实际进容器执行
	if !strings.Contains(text, "DAIDAI_CONTAINER_PROBE_OK") {
		t.Fatal("customize.sh 缺少容器能力探测的哨兵字符串")
	}
	// 探测必须排在装依赖之前：装依赖耗时且强依赖网络，
	// 先探测才能把「容器起不来」和「网络不通」两类失败区分开
	probeIdx := strings.Index(text, "DAIDAI_CONTAINER_PROBE_OK")
	apkIdx := strings.Index(text, "apk add --no-cache")
	if apkIdx < 0 {
		t.Fatal("customize.sh 找不到 apk 安装段")
	}
	if probeIdx > apkIdx {
		t.Fatal("容器能力探测必须放在装依赖之前")
	}
}

func TestMagiskCheckRuntimesScriptIncludesInstalledRuntimePaths(t *testing.T) {
	scriptPath := filepath.Join("..", "..", "Magisk", "scripts", "check-runtimes.sh")
	data, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read Magisk check-runtimes.sh: %v", err)
	}
	text := string(data)

	requiredSnippets := []string{
		"\"$PANEL_DIR/bin/python/bin\"",
		"\"$PANEL_DIR/bin/node/bin\"",
		"\"$PANEL_DIR/bin\"",
		"PANEL_RUNTIME_PATHS",
	}
	for _, snippet := range requiredSnippets {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected check-runtimes.sh to contain %q", snippet)
		}
	}
}
