package service

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"daidai-panel/database"
	"daidai-panel/model"
)

// playwrightDebian12Packages 是一键安装登记的系统库清单（Debian 12 bookworm，amd64 与 arm64 共用），共 26 个。
//
// 来源：microsoft/playwright 仓库 packages/playwright-core/src/server/registry/nativeDeps.ts
// 里 debian12-x64 的 chromium 依赖组（21 个，debian12-arm64 是直接复制 x64 的，包名完全相同；
// chromium-headless-shell 的依赖组也是 chromium），外加精选的 5 个字体相关包。
//
// 官方 install-deps 总会额外带上 tools 组（11 个），这里只挑了其中 5 个：
//   - fonts-wqy-zenhei：slim 镜像一个中文字体都没有，不装它中文页面截图全是方块；
//   - fonts-liberation、fonts-noto-color-emoji：常见西文字体与 emoji；
//   - libfontconfig1、libfreetype6：本来也会被 libcairo2 / libpango 依赖进来，
//     显式登记是为了容器重建后的自动重装不依赖「被谁顺带装上」这种隐式关系。
//
// 刻意不装 xvfb（会拉进 libgl1-mesa-dri、libllvm，上百 MB，只有有头模式才需要）
// 和其余几个字体包。包越多，容器重建后的自动重装窗口就越长。
//
// 维护：Playwright 升级或镜像换代（bookworm → trixie，多数包名会变成 *t64）时要重新核对；
// 其它发行版 / 版本在 PlanPlaywrightRuntime 里明确拒绝，而不是套用这份清单。
var playwrightDebian12Packages = [...]string{
	// chromium 必需库（21）
	"libasound2",
	"libatk-bridge2.0-0",
	"libatk1.0-0",
	"libatspi2.0-0",
	"libcairo2",
	"libcups2",
	"libdbus-1-3",
	"libdrm2",
	"libgbm1",
	"libglib2.0-0",
	"libnspr4",
	"libnss3",
	"libpango-1.0-0",
	"libx11-6",
	"libxcb1",
	"libxcomposite1",
	"libxdamage1",
	"libxext6",
	"libxfixes3",
	"libxkbcommon0",
	"libxrandr2",
	// 字体相关（5）
	"fonts-liberation",
	"fonts-wqy-zenhei",
	"fonts-noto-color-emoji",
	"libfontconfig1",
	"libfreetype6",
}

// PlaywrightPythonPackage 是一键安装登记的 Python 依赖名。
const PlaywrightPythonPackage = "playwright"

// PlaywrightDebian12Packages 返回清单的副本，调用方改动不会影响常量表本身。
func PlaywrightDebian12Packages() []string {
	return append([]string(nil), playwrightDebian12Packages[:]...)
}

// LinuxOSRelease 是 /etc/os-release 里一键安装关心的三个字段。
type LinuxOSRelease struct {
	ID              string
	VersionID       string
	VersionCodename string
}

// linuxOSReleaseFiles 按 os-release(5) 的约定依次尝试；抽成变量只为测试能换成临时文件。
var linuxOSReleaseFiles = []string{"/etc/os-release", "/usr/lib/os-release"}

// DetectLinuxOSRelease 读 ID、VERSION_ID、VERSION_CODENAME。
// 现有的 DetectLinuxDistribution 只读 ID，而包清单必须按版本挑（trixie 的包名大多带 t64 后缀）。
func DetectLinuxOSRelease() LinuxOSRelease {
	for _, path := range linuxOSReleaseFiles {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		return parseLinuxOSRelease(string(data))
	}
	return LinuxOSRelease{}
}

func parseLinuxOSRelease(content string) LinuxOSRelease {
	var release LinuxOSRelease
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "ID":
			release.ID = strings.ToLower(value)
		case "VERSION_ID":
			release.VersionID = value
		case "VERSION_CODENAME":
			release.VersionCodename = strings.ToLower(value)
		}
	}
	return release
}

func (r LinuxOSRelease) describe() string {
	if r.ID == "" && r.VersionID == "" && r.VersionCodename == "" {
		return "未能读取 /etc/os-release"
	}
	return fmt.Sprintf("ID=%s VERSION_ID=%s VERSION_CODENAME=%s", r.ID, r.VersionID, r.VersionCodename)
}

// PlaywrightRuntimePlan 是一键安装的判定结果，也直接作为 GET /deps/playwright 的主体。
type PlaywrightRuntimePlan struct {
	Supported    bool     `json:"supported"`
	Reason       string   `json:"reason"`
	Distribution string   `json:"distribution"`
	VersionID    string   `json:"version_id"`
	Arch         string   `json:"arch"`
	Packages     []string `json:"packages"`
	BrowsersPath string   `json:"browsers_path"`
}

// playwrightRuntimeFacts 是判定需要的全部环境事实。
// 「读环境」与「做判定」拆开，判定部分就能在 Windows 开发机上把每个分支跑全。
type playwrightRuntimeFacts struct {
	GOOS           string
	Arch           string
	OSRelease      LinuxOSRelease
	PackageManager string
	// ManagedBrowsersPath 是 DefaultPlaywrightBrowsersPath()：非空才说明浏览器目录由面板托管（容器部署）。
	ManagedBrowsersPath string
	Magisk              bool
	// BrowsersPath 是 ResolvePlaywrightBrowsersPath()：任务里实际会用的目录，原样回给前端展示。
	BrowsersPath string
}

var playwrightRuntimeFactsFunc = detectPlaywrightRuntimeFacts

func detectPlaywrightRuntimeFacts() playwrightRuntimeFacts {
	facts := playwrightRuntimeFacts{
		GOOS:         runtime.GOOS,
		Arch:         runtime.GOARCH,
		BrowsersPath: ResolvePlaywrightBrowsersPath(),
	}
	if facts.GOOS != "linux" {
		return facts
	}
	facts.OSRelease = DetectLinuxOSRelease()
	if manager, err := DetectLinuxPackageManager(); err == nil {
		facts.PackageManager = manager.Name
	}
	facts.Magisk = playwrightMagiskFunc()
	facts.ManagedBrowsersPath = DefaultPlaywrightBrowsersPath()
	return facts
}

// PlanPlaywrightRuntime 判定当前环境能不能一键安装 Playwright 运行环境，能的话给出系统库清单。
// 不含 root 判定：那一条由调用方用 EnsureLinuxPackageManagerPrivilege 单独检查，文案按部署形态分岔。
func PlanPlaywrightRuntime() PlaywrightRuntimePlan {
	return planPlaywrightRuntime(playwrightRuntimeFactsFunc())
}

// planPlaywrightRuntime 的判定顺序：非 Linux → Alpine/apk → 非 apt → 架构 → 非 Debian 12 → 浏览器目录不归面板管。
// 越靠前的原因越「根本」：Alpine 用户该看到的是换镜像，而不是「你的架构不对」。
func planPlaywrightRuntime(facts playwrightRuntimeFacts) PlaywrightRuntimePlan {
	plan := PlaywrightRuntimePlan{
		Distribution: facts.OSRelease.ID,
		VersionID:    facts.OSRelease.VersionID,
		Arch:         facts.Arch,
		Packages:     []string{},
		BrowsersPath: facts.BrowsersPath,
	}

	switch {
	case facts.GOOS != "linux":
		plan.Reason = fmt.Sprintf("一键安装只支持 Linux 上的 Debian 12 版 Docker 镜像，当前系统是 %s", facts.GOOS)
	case facts.OSRelease.ID == "alpine" || facts.PackageManager == "apk":
		plan.Reason = "Alpine 镜像（musl）跑不了 Playwright 官方的 Chromium（glibc 构建），请换 Debian 版镜像 linzixuanzz/daidai-panel:debian"
	case facts.PackageManager != "apt":
		manager := facts.PackageManager
		if manager == "" {
			manager = "未检测到"
		}
		plan.Reason = fmt.Sprintf("一键安装只支持 apt 系统（Debian 12），当前包管理器：%s", manager)
	case facts.Arch != "amd64" && facts.Arch != "arm64":
		plan.Reason = fmt.Sprintf("Playwright 的 Chromium 只有 amd64 / arm64 构建，当前架构是 %s", facts.Arch)
	case facts.OSRelease.ID != "debian" || facts.OSRelease.VersionID != "12":
		plan.Reason = "一键安装目前只内置 Debian 12（bookworm）的系统库清单，当前系统：" + facts.OSRelease.describe()
	case facts.ManagedBrowsersPath == "":
		// 浏览器目录只在容器部署下由面板托管（见 DefaultPlaywrightBrowsersPath）。
		// 这类部署装完系统库和 pip 包也不会自动下载浏览器，一键装出来是个半成品，不如直接说清楚。
		where := "非容器部署"
		if facts.Magisk {
			where = "面具模块版"
		}
		plan.Reason = fmt.Sprintf("一键安装只在 Docker 部署下可用：%s的浏览器目录不由面板托管，"+
			"请在终端执行 python3 -m playwright install --with-deps chromium", where)
	default:
		plan.Supported = true
		plan.Packages = PlaywrightDebian12Packages()
	}
	return plan
}

// 浏览器下载这一步前后的日志行。依赖失败提示靠这两行判断「失败发生在下载阶段」，
// 所以写日志与判定两边必须引用同一组常量。
const (
	PlaywrightDownloadStartPrefix = "[Playwright] 正在下载 Chromium 到 "
	PlaywrightDownloadReadyLine   = "[Playwright] 浏览器已就绪"
)

// playwrightDownloadSizeNote 跟在下载开始行后面，讲清楚这一步为什么会长时间「没反应」（issue #146）。
//
// Playwright 的进度条靠 \r 原地刷新，而面板的日志采集用 bufio.Scanner 按 \n 切行，
// 非 TTY 下整个下载期间一行都不会输出 —— 用户看到的就是日志停在下载开始行不动。
// 与其改 Scanner 的切分规则（会把所有依赖的进度条撑成很多行），不如把预期先说清楚。
const playwrightDownloadSizeNote = "（约 150-300MB，国内网络下可能需要十几分钟；下载期间日志不刷新属正常现象）"

// PlaywrightDownloadStartLine 生成下载开始那一行。目录为空说明用户在面板里把变量设成了空串，
// 此时 Playwright 用它自己的默认目录，照实写出来，免得日志里出现一个看不懂的空路径。
func PlaywrightDownloadStartLine(browsersPath string) string {
	if strings.TrimSpace(browsersPath) == "" {
		return PlaywrightDownloadStartPrefix + "Playwright 默认目录（PLAYWRIGHT_BROWSERS_PATH 为空）" + playwrightDownloadSizeNote
	}
	return PlaywrightDownloadStartPrefix + browsersPath + playwrightDownloadSizeNote
}

var playwrightManagedPythonFunc = ResolveManagedPythonBinaryForPythonVersion

// PlaywrightBrowserDownloadApplies 判断 pip 装完 packageName 之后要不要接着下载 Chromium。
//
// 只认按 PEP 503 归一化后恰好是 playwright 的包（含 playwright==x 这种写法），
// 并且只在浏览器目录由面板托管（容器部署）、且不是 Alpine 时才下：
//   - Windows 桌面版、裸机、面具版的用户自己管理浏览器，给每个手动装 playwright 的人
//     悄悄多下 150-300MB 是不可接受的副作用；
//   - Alpine 上官方 Chromium 本来就跑不起来，下了也白下。
//
// 网页安装、重装、一键安装都经过这里；重启后的自动重装不走这条路 ——
// 浏览器在数据卷里，重建容器不会丢。
func PlaywrightBrowserDownloadApplies(packageName string) bool {
	if CanonicalizePythonPackageName(packageName) != PlaywrightPythonPackage {
		return false
	}
	if DefaultPlaywrightBrowsersPath() == "" {
		return false
	}
	return DetectLinuxOSRelease().ID != "alpine"
}

// NewPlaywrightBrowserInstallCommand 构造 `<托管 venv 的 python> -m playwright install chromium`。
//
// 必须在 pip 装完之后才调用（此时 venv 里才有 playwright 模块）。返回的第二个值是实际下载目录，
// 供调用方写日志。环境：面板代理、可写 HOME，并显式设 PLAYWRIGHT_BROWSERS_PATH ——
// 依赖安装子进程只继承 os.Environ，看不到环境变量页里的值，不显式传就会下到与任务不一样的目录。
// 环境变量页里设的 PLAYWRIGHT_DOWNLOAD_HOST 也一并带上，这样失败提示里「设置下载镜像」那条出路在面板内就能完成。
func NewPlaywrightBrowserInstallCommand(pythonVersion string) (*exec.Cmd, string, error) {
	pythonBin := playwrightManagedPythonFunc(pythonVersion)
	if strings.TrimSpace(pythonBin) == "" {
		return nil, "", fmt.Errorf("[Playwright] 找不到 Python %s 的面板托管解释器，无法下载 Chromium，请确认该版本的依赖环境可用后重装本依赖",
			NormalizePythonVersionOrDefault(pythonVersion))
	}

	browsersPath := ResolvePlaywrightBrowsersPath()
	cmd := exec.Command(pythonBin, "-m", "playwright", "install", "chromium")
	// SanitizePipEnv 顺带剥掉 PYTHONPATH / PYTHONHOME：它们会污染 venv 解释器的模块搜索路径。
	env := WritableHomeEnv(SanitizePipEnv(AppendProxyEnv(os.Environ())))
	// 顺序契约：先写面板默认镜像，再叠用户值（issue #146）。
	// withEnvEntry 是「先剔同名再追加」，两次调用的先后天然实现「用户值优先」。
	// 用户值要先滤掉空串，否则一条 enabled 但 Value 为空的记录会把默认镜像覆盖成空串、静默失效。
	if defaultHost := DefaultPlaywrightDownloadHost(); defaultHost != "" {
		env = withEnvEntry(env, PlaywrightDownloadHostEnv, defaultHost)
	}
	env = withEnvEntries(env, nonEmptyEnvValues(panelUserEnvValues(PlaywrightDownloadHostEnv)))
	cmd.Env = withEnvEntry(env, PlaywrightBrowsersPathEnv, browsersPath)
	return cmd, browsersPath, nil
}

// playwrightHintEnv 是 BuildPlaywrightEnvironmentHint 需要的环境事实。
type playwrightHintEnv struct {
	// BrowsersPath 是任务里实际生效的 PLAYWRIGHT_BROWSERS_PATH
	BrowsersPath string
	// OneClick 表示当前部署能用「依赖管理 → Linux」里的一键安装（容器部署）
	OneClick bool
	// PendingLinux 返回正在安装 / 排队中的 Linux 依赖数；只在命中缺库关键词时才调用，避免每次失败都查库
	PendingLinux func() int64
}

var playwrightHintEnvFunc = func() playwrightHintEnv {
	return playwrightHintEnv{
		BrowsersPath: ResolvePlaywrightBrowsersPath(),
		OneClick:     DefaultPlaywrightBrowsersPath() != "",
		PendingLinux: countPendingLinuxDependencies,
	}
}

func countPendingLinuxDependencies() int64 {
	if database.DB == nil {
		return 0
	}
	var count int64
	database.DB.Model(&model.Dependency{}).
		Where("type = ? AND status IN ?", model.DepTypeLinux, []string{model.DepStatusInstalling, model.DepStatusQueued}).
		Count(&count)
	return count
}

// BuildPlaywrightEnvironmentHint 针对任务 / 调试运行里 Playwright 的两类环境故障给出一句提示。
//
// 与 BuildModuleCompatibilityHint 分开写：那是纯函数、有现成测试锁着，而这里要查库（正在重装的系统依赖数）
// 和读环境（浏览器目录、是不是容器），这些都通过 playwrightHintEnvFunc 注入。
// 提示会进任务失败摘要，摘要截断到 320 字符，所以每条都要写短。
func BuildPlaywrightEnvironmentHint(output string) string {
	lower := strings.ToLower(output)
	if lower == "" {
		return ""
	}
	missingBrowser := strings.Contains(lower, "executable doesn't exist") && strings.Contains(lower, "ms-playwright")
	missingLibs := strings.Contains(lower, "host system is missing dependencies") ||
		strings.Contains(lower, "error while loading shared libraries")
	if !missingBrowser && !missingLibs {
		return ""
	}
	return buildPlaywrightEnvironmentHint(lower, missingBrowser, playwrightHintEnvFunc())
}

func buildPlaywrightEnvironmentHint(lower string, missingBrowser bool, env playwrightHintEnv) string {
	if missingBrowser {
		current := env.BrowsersPath
		if strings.TrimSpace(current) == "" {
			current = "未设置（Playwright 默认目录）"
		}
		fix := "请执行 python3 -m playwright install chromium 重新下载"
		if env.OneClick {
			fix = "请到「依赖管理 → Linux」点「安装 Playwright 运行环境」重新下载"
		}
		return fmt.Sprintf("[提示] Playwright 找不到浏览器，当前 PLAYWRIGHT_BROWSERS_PATH=%s；"+
			"报错路径不在该目录下说明脚本或环境变量改了目录，升级 playwright 后所需的浏览器版本变了也会这样。%s。", current, fix)
	}

	// 缺系统库。容器重建后启动校验会在后台串行重装 Linux 依赖，这段时间里跑的任务必然报缺库，
	// 此时该让用户等，而不是再去点一次安装。
	if env.PendingLinux != nil {
		if pending := env.PendingLinux(); pending > 0 {
			return fmt.Sprintf("[提示] 容器重建后正在后台自动重装 %d 个系统依赖，完成后重试即可（进度见「依赖管理 → Linux」）。", pending)
		}
	}
	// "error while loading shared libraries" 是任何原生程序缺库都会报的通用错误，
	// 只有报错里提到 playwright 时才把人往 Playwright 一键安装上引，否则宁可不给提示。
	if !strings.Contains(lower, "host system is missing dependencies") && !strings.Contains(lower, "playwright") {
		return ""
	}
	if env.OneClick {
		return "[提示] Playwright 缺少系统库，请到「依赖管理 → Linux」点「安装 Playwright 运行环境」补装后重试。"
	}
	return "[提示] Playwright 缺少系统库，请以 root 执行 python3 -m playwright install-deps chromium 补装后重试。"
}

// BuildRuntimeFailureHint 是任务 / 调试运行 / run-code 失败时统一调用的提示入口：
// 先认 ESM 兼容问题，再认 Playwright 环境问题，两者的关键词互不相交。
func BuildRuntimeFailureHint(output string) string {
	if hint := BuildModuleCompatibilityHint(output); hint != "" {
		return hint
	}
	return BuildPlaywrightEnvironmentHint(output)
}
