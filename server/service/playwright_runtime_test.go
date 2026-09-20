package service

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

const bookwormOSRelease = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
`

func TestParseLinuxOSRelease(t *testing.T) {
	got := parseLinuxOSRelease(bookwormOSRelease)
	want := LinuxOSRelease{ID: "debian", VersionID: "12", VersionCodename: "bookworm"}
	if got != want {
		t.Fatalf("期望 %+v，实际 %+v", want, got)
	}

	// 单引号、注释、空行、大写 ID 都要容忍。
	got = parseLinuxOSRelease("# comment\n\nID='Alpine'\nVERSION_ID=3.20.3\n")
	if got.ID != "alpine" || got.VersionID != "3.20.3" || got.VersionCodename != "" {
		t.Fatalf("解析结果不对：%+v", got)
	}
}

// os-release(5)：/etc/os-release 不在时退到 /usr/lib/os-release。
func TestDetectLinuxOSReleaseFallsBackToUsrLib(t *testing.T) {
	old := linuxOSReleaseFiles
	t.Cleanup(func() { linuxOSReleaseFiles = old })

	dir := t.TempDir()
	fallback := filepath.Join(dir, "usr-lib-os-release")
	if err := os.WriteFile(fallback, []byte(bookwormOSRelease), 0o644); err != nil {
		t.Fatal(err)
	}
	linuxOSReleaseFiles = []string{filepath.Join(dir, "missing"), fallback}

	if got := DetectLinuxOSRelease(); got.ID != "debian" || got.VersionID != "12" {
		t.Fatalf("应读到回退文件里的 Debian 12，实际 %+v", got)
	}

	linuxOSReleaseFiles = []string{filepath.Join(dir, "missing")}
	if got := DetectLinuxOSRelease(); got != (LinuxOSRelease{}) {
		t.Fatalf("两个文件都不在时应返回空值，实际 %+v", got)
	}
}

// 清单严格按 PRD：Playwright nativeDeps.ts 里 debian12 的 chromium 组 21 个 + 精选字体 5 个，共 26 个。
func TestPlaywrightDebian12PackagesList(t *testing.T) {
	packages := PlaywrightDebian12Packages()
	if len(packages) != 26 {
		t.Fatalf("清单应为 26 个包，实际 %d 个：%v", len(packages), packages)
	}
	seen := make(map[string]struct{}, len(packages))
	for _, name := range packages {
		if _, dup := seen[name]; dup {
			t.Fatalf("清单里有重复的包：%s", name)
		}
		seen[name] = struct{}{}
	}
	for _, want := range []string{"libnss3", "libgbm1", "libasound2", "libxkbcommon0", "fonts-wqy-zenhei", "fonts-noto-color-emoji", "libfreetype6"} {
		if _, ok := seen[want]; !ok {
			t.Fatalf("清单里缺少 %s", want)
		}
	}
	// xvfb 会拉进上百 MB 的 mesa / llvm，只有有头模式才需要，刻意不装。
	if _, ok := seen["xvfb"]; ok {
		t.Fatal("清单里不应包含 xvfb")
	}

	// 返回的是副本：调用方改它不能影响常量表。
	packages[0] = "tampered"
	if PlaywrightDebian12Packages()[0] == "tampered" {
		t.Fatal("PlaywrightDebian12Packages 必须返回副本")
	}
}

func TestPlanPlaywrightRuntime(t *testing.T) {
	bookworm := LinuxOSRelease{ID: "debian", VersionID: "12", VersionCodename: "bookworm"}
	supported := playwrightRuntimeFacts{
		GOOS:                "linux",
		Arch:                "amd64",
		OSRelease:           bookworm,
		PackageManager:      "apt",
		ManagedBrowsersPath: "/app/Dumb-Panel/deps/ms-playwright",
		BrowsersPath:        "/app/Dumb-Panel/deps/ms-playwright",
	}
	with := func(mutate func(*playwrightRuntimeFacts)) playwrightRuntimeFacts {
		facts := supported
		mutate(&facts)
		return facts
	}

	cases := []struct {
		name       string
		facts      playwrightRuntimeFacts
		supported  bool
		reasonHave []string
	}{
		{name: "Debian 12 amd64 容器", facts: supported, supported: true},
		{name: "Debian 12 arm64 容器", facts: with(func(f *playwrightRuntimeFacts) { f.Arch = "arm64" }), supported: true},
		{name: "Windows", facts: with(func(f *playwrightRuntimeFacts) { f.GOOS = "windows" }), reasonHave: []string{"windows"}},
		{
			// 判定顺序：Alpine 排在架构之前，386 的 Alpine 用户该看到的是换镜像。
			name: "Alpine（按 os-release）且架构也不对",
			facts: with(func(f *playwrightRuntimeFacts) {
				f.OSRelease = LinuxOSRelease{ID: "alpine"}
				f.PackageManager = "apk"
				f.Arch = "386"
			}),
			reasonHave: []string{"Alpine", "linzixuanzz/daidai-panel:debian"},
		},
		{name: "只认出 apk", facts: with(func(f *playwrightRuntimeFacts) { f.OSRelease = LinuxOSRelease{}; f.PackageManager = "apk" }), reasonHave: []string{"Alpine"}},
		{name: "dnf 系", facts: with(func(f *playwrightRuntimeFacts) { f.PackageManager = "dnf" }), reasonHave: []string{"apt", "dnf"}},
		{name: "探不到包管理器", facts: with(func(f *playwrightRuntimeFacts) { f.PackageManager = "" }), reasonHave: []string{"未检测到"}},
		{name: "32 位 arm", facts: with(func(f *playwrightRuntimeFacts) { f.Arch = "arm" }), reasonHave: []string{"amd64 / arm64", "arm"}},
		{
			name: "Debian 13 trixie（包名多数带 t64）",
			facts: with(func(f *playwrightRuntimeFacts) {
				f.OSRelease = LinuxOSRelease{ID: "debian", VersionID: "13", VersionCodename: "trixie"}
			}),
			reasonHave: []string{"Debian 12", "VERSION_ID=13", "trixie"},
		},
		{
			name: "Ubuntu",
			facts: with(func(f *playwrightRuntimeFacts) {
				f.OSRelease = LinuxOSRelease{ID: "ubuntu", VersionID: "24.04", VersionCodename: "noble"}
			}),
			reasonHave: []string{"ID=ubuntu"},
		},
		{
			name:       "读不到 os-release",
			facts:      with(func(f *playwrightRuntimeFacts) { f.OSRelease = LinuxOSRelease{} }),
			reasonHave: []string{"未能读取 /etc/os-release"},
		},
		{
			// 浏览器目录不归面板管时，装完系统库和 pip 包也不会自动下载浏览器，一键装出来是半成品。
			name:       "Debian 12 裸机",
			facts:      with(func(f *playwrightRuntimeFacts) { f.ManagedBrowsersPath = "" }),
			reasonHave: []string{"Docker", "非容器部署", "install --with-deps chromium"},
		},
		{
			name:       "面具模块版的 Debian 容器",
			facts:      with(func(f *playwrightRuntimeFacts) { f.ManagedBrowsersPath = ""; f.Magisk = true }),
			reasonHave: []string{"面具模块版"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := planPlaywrightRuntime(tc.facts)
			if plan.Supported != tc.supported {
				t.Fatalf("supported 期望 %v，实际 %v（reason=%q）", tc.supported, plan.Supported, plan.Reason)
			}
			if plan.Arch != tc.facts.Arch || plan.Distribution != tc.facts.OSRelease.ID || plan.VersionID != tc.facts.OSRelease.VersionID {
				t.Fatalf("环境字段应原样回填，实际 %+v", plan)
			}
			if plan.BrowsersPath != tc.facts.BrowsersPath {
				t.Fatalf("browsers_path 应原样回填，实际 %q", plan.BrowsersPath)
			}
			if plan.Packages == nil {
				t.Fatal("packages 不能是 nil（JSON 里会变成 null，前端按数组读）")
			}
			if tc.supported {
				if plan.Reason != "" || !slices.Equal(plan.Packages, PlaywrightDebian12Packages()) {
					t.Fatalf("支持时应给出完整清单且不带原因，实际 %+v", plan)
				}
				return
			}
			if len(plan.Packages) != 0 {
				t.Fatalf("不支持时不应给出清单，实际 %v", plan.Packages)
			}
			for _, want := range tc.reasonHave {
				if !strings.Contains(plan.Reason, want) {
					t.Fatalf("原因里应包含 %q，实际 %q", want, plan.Reason)
				}
			}
		})
	}
}

// 链式下载只认 playwright 本身（含版本写法），只在容器、非 Alpine 下生效。
func TestPlaywrightBrowserDownloadApplies(t *testing.T) {
	testutil.SetupTestEnv(t)
	old := linuxOSReleaseFiles
	t.Cleanup(func() { linuxOSReleaseFiles = old })
	osRelease := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(osRelease, []byte(bookwormOSRelease), 0o644); err != nil {
		t.Fatal(err)
	}
	linuxOSReleaseFiles = []string{osRelease}

	stubPlaywrightDeployment(t, "linux", true, false)
	for name, want := range map[string]bool{
		"playwright":          true,
		"Playwright==1.47.0":  true,
		"playwright>=1.40":    true,
		"playwright-stealth":  false,
		"pytest-playwright":   false,
		"requests":            false,
		" playwright[extra] ": true,
	} {
		if got := PlaywrightBrowserDownloadApplies(name); got != want {
			t.Fatalf("%q 期望 %v，实际 %v", name, want, got)
		}
	}

	// 非容器（Windows 桌面版、裸机）：给每个手动装 playwright 的人多下几百 MB 是不可接受的副作用。
	stubPlaywrightDeployment(t, "linux", false, false)
	if PlaywrightBrowserDownloadApplies("playwright") {
		t.Fatal("非容器部署不应链式下载浏览器")
	}

	// Alpine：官方 Chromium 跑不起来，下了也白下。
	stubPlaywrightDeployment(t, "linux", true, false)
	if err := os.WriteFile(osRelease, []byte("ID=alpine\nVERSION_ID=3.20.3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if PlaywrightBrowserDownloadApplies("playwright") {
		t.Fatal("Alpine 不应链式下载浏览器")
	}
}

func TestNewPlaywrightBrowserInstallCommand(t *testing.T) {
	testutil.SetupTestEnv(t)
	stubPlaywrightDeployment(t, "linux", true, false)
	oldPython := playwrightManagedPythonFunc
	t.Cleanup(func() { playwrightManagedPythonFunc = oldPython })

	var askedVersion string
	playwrightManagedPythonFunc = func(version string) string {
		askedVersion = version
		return "/app/Dumb-Panel/deps/python/3.12/bin/python"
	}

	// 进程环境里有一个旧值，环境变量页里另有用户值：下载必须以任务看到的（环境变量页）为准，且只留一份。
	t.Setenv(PlaywrightBrowsersPathEnv, "/from/process")
	for _, item := range []model.EnvVar{
		{Name: PlaywrightBrowsersPathEnv, Value: "/from/env-page", Enabled: true},
		{Name: PlaywrightDownloadHostEnv, Value: "https://mirror.example.com/playwright", Enabled: true},
	} {
		if err := database.DB.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}

	cmd, browsersPath, err := NewPlaywrightBrowserInstallCommand("3.12")
	if err != nil {
		t.Fatalf("构造下载命令失败：%v", err)
	}
	if askedVersion != "3.12" {
		t.Fatalf("应按依赖记录的 Python 版本取解释器，实际取的是 %q", askedVersion)
	}
	if browsersPath != "/from/env-page" {
		t.Fatalf("下载目录应与任务一致（环境变量页优先），实际 %q", browsersPath)
	}
	if !slices.Equal(cmd.Args[1:], []string{"-m", "playwright", "install", "chromium"}) {
		t.Fatalf("命令参数不对：%v", cmd.Args)
	}

	var pathEntries, hostEntries []string
	for _, entry := range cmd.Env {
		switch {
		case strings.HasPrefix(entry, PlaywrightBrowsersPathEnv+"="):
			pathEntries = append(pathEntries, entry)
		case strings.HasPrefix(entry, PlaywrightDownloadHostEnv+"="):
			hostEntries = append(hostEntries, entry)
		}
	}
	if !slices.Equal(pathEntries, []string{PlaywrightBrowsersPathEnv + "=/from/env-page"}) {
		t.Fatalf("下载子进程的 PLAYWRIGHT_BROWSERS_PATH 应只有环境变量页那一份，实际 %v", pathEntries)
	}
	if !slices.Equal(hostEntries, []string{PlaywrightDownloadHostEnv + "=https://mirror.example.com/playwright"}) {
		t.Fatalf("环境变量页里设的下载镜像要带进下载子进程，实际 %v", hostEntries)
	}

	// 找不到托管解释器时明确报错，而不是退回系统 python（那里没有刚装的 playwright）。
	playwrightManagedPythonFunc = func(string) string { return "" }
	if _, _, err := NewPlaywrightBrowserInstallCommand("3.12"); err == nil || !strings.Contains(err.Error(), "托管解释器") {
		t.Fatalf("找不到解释器时应报错，实际 err=%v", err)
	}
}

func TestPlaywrightDownloadStartLine(t *testing.T) {
	// v3.3.2 起开始行后面跟着体量与耗时说明（issue #146）：日志停在这一行不动是 Playwright 的进度条
	// 靠 \r 原地刷新、面板按行采集导致的，说明必须写在这条日志里才有人看见。
	if got := PlaywrightDownloadStartLine("/data/deps/ms-playwright"); got != PlaywrightDownloadStartPrefix+"/data/deps/ms-playwright"+playwrightDownloadSizeNote {
		t.Fatalf("开始行不对：%q", got)
	}
	if got := PlaywrightDownloadStartLine("/data/deps/ms-playwright"); !strings.Contains(got, "150-300MB") {
		t.Fatalf("开始行应写明下载体量，实际 %q", got)
	}
	// 变量被设成空串时 Playwright 用它自己的默认目录，日志里不能出现一个空路径。
	if got := PlaywrightDownloadStartLine(""); !strings.HasPrefix(got, PlaywrightDownloadStartPrefix) || !strings.Contains(got, "默认目录") {
		t.Fatalf("空目录时应写明是默认目录，实际 %q", got)
	}
}

func stubPlaywrightHintEnv(t *testing.T, env playwrightHintEnv) {
	t.Helper()
	old := playwrightHintEnvFunc
	t.Cleanup(func() { playwrightHintEnvFunc = old })
	playwrightHintEnvFunc = func() playwrightHintEnv { return env }
}

func TestBuildPlaywrightEnvironmentHint(t *testing.T) {
	const missingBrowser = "playwright._impl._errors.Error: BrowserType.launch: Executable doesn't exist at " +
		"/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell\n" +
		"Looks like Playwright was just installed or updated."
	const missingLib = "BrowserType.launch: Target page, context or browser has been closed\n" +
		"/app/Dumb-Panel/deps/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell: " +
		"error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory"
	const hostMissing = "BrowserType.launch: \nHost system is missing dependencies to run browsers."

	noPending := func() int64 { return 0 }
	cases := []struct {
		name        string
		output      string
		env         playwrightHintEnv
		contains    []string
		notContains []string
		wantEmpty   bool
	}{
		{
			name:     "找不到浏览器（容器）",
			output:   missingBrowser,
			env:      playwrightHintEnv{BrowsersPath: "/app/Dumb-Panel/deps/ms-playwright", OneClick: true, PendingLinux: noPending},
			contains: []string{"PLAYWRIGHT_BROWSERS_PATH=/app/Dumb-Panel/deps/ms-playwright", "依赖管理 → Linux", "安装 Playwright 运行环境"},
		},
		{
			name:        "找不到浏览器（非容器）",
			output:      missingBrowser,
			env:         playwrightHintEnv{OneClick: false, PendingLinux: noPending},
			contains:    []string{"未设置", "python3 -m playwright install chromium"},
			notContains: []string{"安装 Playwright 运行环境"},
		},
		{
			// 容器重建后启动校验正在后台重装系统库：该让用户等，而不是再去点一次安装。
			name:        "缺库且有系统依赖正在重装",
			output:      missingLib,
			env:         playwrightHintEnv{OneClick: true, PendingLinux: func() int64 { return 7 }},
			contains:    []string{"正在后台自动重装 7 个系统依赖", "完成后重试"},
			notContains: []string{"安装 Playwright 运行环境"},
		},
		{
			name:     "缺库且没有在重装",
			output:   missingLib,
			env:      playwrightHintEnv{OneClick: true, PendingLinux: noPending},
			contains: []string{"依赖管理 → Linux", "安装 Playwright 运行环境"},
		},
		{
			name:     "Host system is missing dependencies",
			output:   hostMissing,
			env:      playwrightHintEnv{OneClick: true, PendingLinux: noPending},
			contains: []string{"安装 Playwright 运行环境"},
		},
		{
			name:     "缺库（非容器）给 install-deps",
			output:   hostMissing,
			env:      playwrightHintEnv{OneClick: false, PendingLinux: noPending},
			contains: []string{"install-deps"},
		},
		{
			// 通用的缺库报错与 Playwright 无关时，不能把人往 Playwright 一键安装上引。
			name:      "与 Playwright 无关的缺库报错",
			output:    "./tool: error while loading shared libraries: libssl.so.1.1: cannot open shared object file",
			env:       playwrightHintEnv{OneClick: true, PendingLinux: noPending},
			wantEmpty: true,
		},
		{
			// 但「正在重装系统依赖」对任何缺库报错都成立。
			name:     "与 Playwright 无关的缺库报错、但系统依赖正在重装",
			output:   "./tool: error while loading shared libraries: libssl.so.1.1: cannot open shared object file",
			env:      playwrightHintEnv{OneClick: true, PendingLinux: func() int64 { return 3 }},
			contains: []string{"3 个系统依赖"},
		},
		{
			name:      "只有 Executable doesn't exist 而没有 ms-playwright",
			output:    "Error: Executable doesn't exist at /usr/bin/foo",
			env:       playwrightHintEnv{OneClick: true, PendingLinux: noPending},
			wantEmpty: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubPlaywrightHintEnv(t, tc.env)
			got := BuildPlaywrightEnvironmentHint(tc.output)
			if tc.wantEmpty {
				if got != "" {
					t.Fatalf("期望不给提示，实际 %q", got)
				}
				return
			}
			for _, want := range tc.contains {
				if !strings.Contains(got, want) {
					t.Fatalf("提示里应包含 %q，实际 %q", want, got)
				}
			}
			for _, unwanted := range tc.notContains {
				if strings.Contains(got, unwanted) {
					t.Fatalf("提示里不应包含 %q，实际 %q", unwanted, got)
				}
			}
			// 提示会进失败摘要（截断到 320 字符），必须写短、单行。
			if n := len([]rune(got)); n > 320 {
				t.Fatalf("提示超过 320 字符（%d），会被截断：%q", n, got)
			}
			if strings.Contains(got, "\n") {
				t.Fatalf("提示应是单行，实际 %q", got)
			}
		})
	}
}

// 不命中关键词时连环境都不去读：任务每次失败都会调它，不能每次都查库。
func TestBuildPlaywrightEnvironmentHintSkipsEnvLookupWhenUnrelated(t *testing.T) {
	old := playwrightHintEnvFunc
	t.Cleanup(func() { playwrightHintEnvFunc = old })
	called := false
	playwrightHintEnvFunc = func() playwrightHintEnv {
		called = true
		return playwrightHintEnv{}
	}

	if got := BuildPlaywrightEnvironmentHint("Traceback (most recent call last):\nKeyError: 'token'"); got != "" {
		t.Fatalf("无关报错不应给提示，实际 %q", got)
	}
	if called {
		t.Fatal("无关报错不应去读环境 / 查库")
	}
}

func TestCountPendingLinuxDependencies(t *testing.T) {
	testutil.SetupTestEnv(t)
	for _, dep := range []model.Dependency{
		{Type: model.DepTypeLinux, Name: "libnss3", Status: model.DepStatusInstalling},
		{Type: model.DepTypeLinux, Name: "libgbm1", Status: model.DepStatusQueued},
		{Type: model.DepTypeLinux, Name: "curl", Status: model.DepStatusInstalled},
		{Type: model.DepTypeLinux, Name: "git", Status: model.DepStatusFailed},
		{Type: model.DepTypePython, Name: "playwright", Status: model.DepStatusInstalling},
	} {
		if err := database.DB.Create(&dep).Error; err != nil {
			t.Fatal(err)
		}
	}
	if got := countPendingLinuxDependencies(); got != 2 {
		t.Fatalf("只数 Linux 的 installing / queued，期望 2，实际 %d", got)
	}
}

// 统一入口：ESM 优先，其次 Playwright；两者都不命中返回空串。任务失败摘要也走这里。
func TestBuildRuntimeFailureHintCombinesModuleAndPlaywrightHints(t *testing.T) {
	stubPlaywrightHintEnv(t, playwrightHintEnv{BrowsersPath: "/data/deps/ms-playwright", OneClick: true, PendingLinux: func() int64 { return 0 }})

	esm := "Error [ERR_REQUIRE_ESM]: require() of ES Module /app/Dumb-Panel/deps/nodejs/node_modules/uuid/dist-node/index.js from /app/Dumb-Panel/scripts/wc.js not supported."
	if got := BuildRuntimeFailureHint(esm); got != BuildModuleCompatibilityHint(esm) || got == "" {
		t.Fatalf("ESM 报错应返回 ESM 提示，实际 %q", got)
	}

	playwright := "Executable doesn't exist at /root/.cache/ms-playwright/chromium-1181/chrome-linux/chrome"
	if got := BuildRuntimeFailureHint(playwright); !strings.Contains(got, "Playwright 找不到浏览器") {
		t.Fatalf("Playwright 报错应返回 Playwright 提示，实际 %q", got)
	}
	if got := summarizeTaskFailureOutput(playwright); !strings.Contains(got, "Playwright 找不到浏览器") {
		t.Fatalf("任务失败摘要应带上 Playwright 提示，实际 %q", got)
	}

	if got := BuildRuntimeFailureHint("ZeroDivisionError: division by zero"); got != "" {
		t.Fatalf("无关报错不应给提示，实际 %q", got)
	}
}
