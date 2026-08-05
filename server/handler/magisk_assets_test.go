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

// 下面这几个针对 Magisk 脚本的断言都是纯静态字符串检查。
// 它们只能防止相应改动被整段删掉 / 改回旧写法，**防不住逻辑写错**，
// 也不构成"Magisk 模块有测试覆盖"。真正的验证只能靠真机安装 ——
// Debian flavor 更是连一次真机安装都还没做过。

// readMagiskScript 统一去掉 CR：Windows 检出可能是 CRLF，
// 否则按行 / 按 heredoc 结束标记做的断言会在 Windows 上莫名其妙地失败。
func readMagiskScript(t *testing.T, name string) string {
	t.Helper()
	scriptPath := filepath.Join("..", "..", "Magisk", name)
	data, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read Magisk %s: %v", name, err)
	}
	return strings.ReplaceAll(string(data), "\r\n", "\n")
}

func readMagiskCustomizeScript(t *testing.T) string {
	t.Helper()
	return readMagiskScript(t, "customize.sh")
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

// heredocBlock 取出 `<< 'MARKER'` 与行首 `MARKER` 之间的正文。
// 找不到起始 / 结束标记时直接 Fatal —— 标记被改名说明装依赖那段被重写过，
// 必须回来同步断言，而不是让测试静默变成空跑。
func heredocBlock(t *testing.T, text, marker string) string {
	t.Helper()
	start := strings.Index(text, "<< '"+marker+"'")
	if start < 0 {
		t.Fatalf("customize.sh 找不到 heredoc 起始标记 %q", marker)
	}
	rest := text[start:]
	end := strings.Index(rest, "\n"+marker+"\n")
	if end < 0 {
		t.Fatalf("customize.sh 找不到 heredoc %q 的结束标记", marker)
	}
	return rest[:end]
}

// 装依赖那几段 heredoc 内都不得使用 set -e：
// Alpine 那句离线包 `apk add --no-network` 本来就允许失败（后面有联网兜底），
// Debian 侧 apt-get 也可能局部失败但仍要走完后面的账号 / SSH 配置。
// 加了 set -e 会让整个安装在中途直接断掉，真正的判据是装完之后的运行时验证。
func TestMagiskCustomizeScriptDependencyHeredocHasNoSetE(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	for _, marker := range []string{
		"DEPS_PKG_ALPINE_EOF",
		"DEPS_PKG_DEBIAN_EOF",
		"DEPS_COMMON_EOF",
	} {
		// 只看真正会被执行的行 —— 脚本里有注释专门解释"为什么不能加 set -e"，
		// 那行本身包含 set -e，不能被当成违规。
		for i, line := range strings.Split(heredocBlock(t, text, marker), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if strings.Contains(trimmed, "set -e") {
				t.Fatalf("装依赖 heredoc %s 第 %d 行不得使用 set -e（包管理器允许局部失败，set -e 会直接中断安装）: %s",
					marker, i+1, trimmed)
			}
		}
	}
}

// ---- flavor（alpine / debian）相关断言 ----------------------------------
//
// 这一组是本次改动里最有价值的静态断言。Debian 容器里没有 /bin/ash，
// 只要「容器能力探测」或「依赖装完验证」里残留了写死的 /bin/ash，
// Debian 版就会 100% 探测失败，而报错完全指不到真正的原因。

// customize.sh 必须读 flavor 标记文件，且缺失 / 非法时回落 alpine。
func TestMagiskCustomizeScriptReadsFlavorWithAlpineDefault(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	for _, snippet := range []string{
		// 缺省值必须在读文件之前先落成 alpine
		"FLAVOR=alpine",
		`if [ -f "$MODPATH/flavor" ]; then`,
		`read -r flavor_raw < "$MODPATH/flavor"`,
		// 只认 debian，其余一律回落 alpine —— 默认值就是安全值
		"debian*) FLAVOR=debian ;;",
		"*) FLAVOR=alpine ;;",
		`if [ "$FLAVOR" = "debian" ]; then`,
	} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected customize.sh to contain flavor snippet %q", snippet)
		}
	}
}

// assertNoHardcodedAsh 检查脚本里出现的 /bin/ash 只允许在注释或 CTR_SHELL 赋值里，
// 任何实际调用（尤其是 rurima ruri ... /bin/ash）都必须走 flavor 变量。
func assertNoHardcodedAsh(t *testing.T, name, text string) {
	t.Helper()
	for i, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, "/bin/ash") {
			continue
		}
		trimmed := strings.TrimSpace(line)
		// 注释（含 heredoc 里的 #!/bin/ash shebang）与 CTR_SHELL 赋值是仅有的两种合法出现
		if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "CTR_SHELL=") {
			continue
		}
		t.Fatalf("%s:%d 出现写死的 /bin/ash，必须改用 $CTR_SHELL（Debian 容器里没有 ash）: %s",
			name, i+1, trimmed)
	}
}

// 能力探测与依赖验证必须使用 flavor 变量而非写死 /bin/ash。
func TestMagiskCustomizeScriptProbeAndVerifyUseFlavorShell(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	for _, snippet := range []string{
		// 两个 flavor 的容器 shell 都要定义
		"CTR_SHELL=/bin/ash",
		"CTR_SHELL=/bin/bash",
		// 容器能力探测
		`probe_out=$("$RURIMA" ruri -p -N -S -A "$rootfs" "$CTR_SHELL" -c `,
		// 依赖装完验证：连着后面那行一起匹配，避免和上面的探测命令撞车
		"\"$RURIMA\" ruri -p -N -S -A \"$rootfs\" \"$CTR_SHELL\" -c '\n" +
			"  for c in python3 node npm git bash; do",
		// 装依赖脚本本身也要按 flavor 选 shell
		`"$RURIMA" ruri -p -N -S -A "$rootfs" "$CTR_SHELL" /tmp/daidai-install-deps.sh`,
	} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected customize.sh to contain flavor-aware snippet %q", snippet)
		}
	}

	assertNoHardcodedAsh(t, "customize.sh", text)
}

// Debian 分支里不得残留任何 Alpine 专有的命令 / 参数 / 镜像源。
func TestMagiskCustomizeScriptDebianBranchHasNoAlpineisms(t *testing.T) {
	text := readMagiskCustomizeScript(t)
	block := heredocBlock(t, text, "DEPS_PKG_DEBIAN_EOF")

	for _, forbidden := range []string{
		"apk ",
		"--no-cache",
		"dl-cdn.alpinelinux.org",
		"/bin/ash",
		"/etc/apk/",
	} {
		// 注释里为了写清映射关系会提到 apk / Alpine，所以逐行判断并跳过注释行
		for i, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				continue
			}
			if strings.Contains(line, forbidden) {
				t.Fatalf("customize.sh Debian 分支第 %d 行出现 Alpine 专有内容 %q: %s", i+1, forbidden, line)
			}
		}
	}

	for _, required := range []string{
		"apt-get install -y --no-install-recommends",
		// bookworm 是 deb822 格式，只改老的 sources.list 会静默走原始源
		"/etc/apt/sources.list.d/debian.sources",
		"mirrors.nju.edu.cn",
		// 没有 python3-venv，service.sh 每次开机建的 deps/python venv 会直接失败
		"python3-venv",
		"ca-certificates",
		// openssh 在 Debian 拆成了 client + server 两个包
		"openssh-client openssh-server",
	} {
		if !strings.Contains(block, required) {
			t.Fatalf("expected customize.sh Debian 分支 to contain %q", required)
		}
	}
}

// bashrc 路径必须按 flavor 走：Alpine 是 /etc/bash/bashrc，Debian 是 /etc/bash.bashrc。
// 写错位置不会报错，只是环境变量静默不生效。
func TestMagiskCustomizeScriptUsesFlavorBashrcPath(t *testing.T) {
	text := readMagiskCustomizeScript(t)

	for _, snippet := range []string{
		`CTR_BASHRC="/etc/bash.bashrc"`,
		`CTR_BASHRC="/etc/bash/bashrc"`,
		`cat > "$rootfs$CTR_BASHRC"`,
	} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected customize.sh to contain bashrc snippet %q", snippet)
		}
	}
	if strings.Contains(text, "cat > $rootfs/etc/bash/bashrc") {
		t.Fatal("customize.sh 不应再写死 Alpine 的 /etc/bash/bashrc 路径")
	}
}

// 运行期脚本同样要按 flavor 取容器 shell —— 装得上但起不来同样是坏的。
func TestMagiskRuntimeScriptsUseFlavorShell(t *testing.T) {
	for _, name := range []string{"service.sh", "action.sh"} {
		text := readMagiskScript(t, name)

		for _, snippet := range []string{
			`if [ -f "$MODDIR/flavor" ]; then`,
			"FLAVOR=alpine",
			`read -r flavor_raw < "$MODDIR/flavor"`,
			"debian*) FLAVOR=debian ;;",
			"*) FLAVOR=alpine ;;",
			"CTR_SHELL=/bin/ash",
			`[ "$FLAVOR" = "debian" ] && CTR_SHELL=/bin/bash`,
		} {
			if !strings.Contains(text, snippet) {
				t.Fatalf("expected %s to contain flavor snippet %q", name, snippet)
			}
		}

		assertNoHardcodedAsh(t, name, text)
	}
}

// build.sh 必须写出 flavor 标记文件，且默认（不传第三个参数）行为与产物名不变。
func TestMagiskBuildScriptWritesFlavorFile(t *testing.T) {
	text := readMagiskScript(t, "build.sh")

	for _, snippet := range []string{
		// 不传时默认 alpine
		`FLAVOR="${3:-alpine}"`,
		// alpine 用空后缀，保证默认产物名与历史逐字节一致
		`  alpine) FLAVOR_SUFFIX="" ;;`,
		`  debian) FLAVOR_SUFFIX="-debian" ;;`,
		`OUTZIP="$DIST/daidai-panel-magisk${FLAVOR_SUFFIX}-v${VERSION}.zip"`,
		// flavor 标记文件必须真的写进 staging
		`printf '%s\n' "$FLAVOR" > "$STAGING/flavor"`,
		// 离线 apk 只进 alpine 包
		`if [ "$FLAVOR" = "alpine" ] && [ -d "$MODDIR/apk" ]; then`,
	} {
		if !strings.Contains(text, snippet) {
			t.Fatalf("expected build.sh to contain %q", snippet)
		}
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
