package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// 本文件是 Linux 系统包镜像源的读写与默认加速逻辑，v3.3.1 从 handler/deps_package_manager.go 整体搬来（#142）。
//
// 搬迁原因：容器重建后的自动重装（backup_runtime.go 的 reinstallDependency）在 service 层，
// 拿不到 handler 里的 ensureDefaultLinuxMirror，只能传 nil，于是重建后的重装一律走 deb.debian.org，
// 国内要慢很多。现在网页安装与重启重装共用这里的 EnsureDefaultLinuxMirror，handler 只留薄封装。
//
// 除了下面单独注明的 debian-security 修正，其余行为与搬迁前逐行一致。

// ReadLinuxMirror 读当前系统包管理器正在用的镜像源；不支持镜像设置的包管理器返回空串。
func ReadLinuxMirror(manager LinuxPackageManager) (string, error) {
	switch manager.Name {
	case "apk":
		return readAPKMirror()
	case "apt":
		return readAPTMirror()
	default:
		return "", nil
	}
}

// SetLinuxMirror 把系统包镜像源改成 mirror；mirror 为空或是官方源时改成默认加速源。
func SetLinuxMirror(manager LinuxPackageManager, distribution, mirror string) error {
	switch manager.Name {
	case "apk":
		return writeAPKMirror(EffectiveLinuxMirror(manager, distribution, mirror))
	case "apt":
		return writeAPTMirror(distribution, EffectiveLinuxMirror(manager, distribution, mirror))
	default:
		return fmt.Errorf("当前系统使用 %s，暂不支持镜像设置", manager.Binary)
	}
}

// EnsureDefaultLinuxMirror 在装系统包之前调用：当前源为空或是官方源时换成默认加速源，
// 用户自己设过的源一律不动。
func EnsureDefaultLinuxMirror(manager LinuxPackageManager, distribution string) error {
	switch manager.Name {
	case "apk", "apt":
	default:
		return nil
	}

	current, err := ReadLinuxMirror(manager)
	if err != nil {
		return err
	}
	if current != "" && !isOfficialLinuxMirror(manager, distribution, current) {
		return nil
	}

	return SetLinuxMirror(manager, distribution, "")
}

// EffectiveLinuxMirror 返回实际生效的镜像源：空或官方源时回落到默认加速源。
func EffectiveLinuxMirror(manager LinuxPackageManager, distribution, current string) string {
	current = strings.TrimRight(strings.TrimSpace(current), "/")
	if current == "" || isOfficialLinuxMirror(manager, distribution, current) {
		return strings.TrimRight(defaultLinuxMirror(manager, distribution), "/")
	}
	return current
}

func readAPKMirror() (string, error) {
	data, err := os.ReadFile("/etc/apk/repositories")
	if err != nil {
		return "", err
	}

	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "/v", 2)
		if len(parts) > 0 {
			return strings.TrimRight(parts[0], "/"), nil
		}
	}

	return "", nil
}

func writeAPKMirror(mirror string) error {
	mirror = strings.TrimSpace(mirror)
	if mirror == "" {
		mirror = defaultLinuxMirror(LinuxPackageManager{Name: "apk", Binary: "apk"}, "")
	}
	if !isHTTPMirror(mirror) {
		return errors.New("Linux 镜像源必须以 http:// 或 https:// 开头")
	}

	mirror = strings.TrimRight(mirror, "/")
	out, err := exec.Command("cat", "/etc/alpine-release").Output()
	ver := "3.19"
	if err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), ".")
		if len(parts) >= 2 {
			ver = parts[0] + "." + parts[1]
		}
	}

	content := fmt.Sprintf("%s/v%s/main\n%s/v%s/community\n", mirror, ver, mirror, ver)
	return os.WriteFile("/etc/apk/repositories", []byte(content), 0o644)
}

func readAPTMirror() (string, error) {
	files, err := listAPTSourceFiles()
	if err != nil {
		return "", err
	}

	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}

		var mirror string
		if strings.HasSuffix(file, ".sources") {
			mirror = extractMirrorFromAPTSources(string(data))
		} else {
			mirror = extractMirrorFromAPTList(string(data))
		}
		if mirror != "" {
			return strings.TrimRight(mirror, "/"), nil
		}
	}

	return "", nil
}

func writeAPTMirror(distribution, mirror string) error {
	files, err := listAPTSourceFiles()
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return errors.New("未找到 apt 软件源配置文件")
	}
	if mirror != "" && !isHTTPMirror(mirror) {
		return errors.New("Linux 镜像源必须以 http:// 或 https:// 开头")
	}

	changedAny := false
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}

		var (
			updated string
			changed bool
		)
		if strings.HasSuffix(file, ".sources") {
			updated, changed = rewriteAPTSourcesContent(string(data), distribution, mirror)
		} else {
			updated, changed = rewriteAPTListContent(string(data), distribution, mirror)
		}

		if !changed {
			continue
		}

		if err := os.WriteFile(file, []byte(updated), 0o644); err != nil {
			return err
		}
		changedAny = true
	}

	if !changedAny {
		return errors.New("未找到可更新的 apt 软件源条目")
	}

	return nil
}

func listAPTSourceFiles() ([]string, error) {
	files := []string{}

	if _, err := os.Stat("/etc/apt/sources.list"); err == nil {
		files = append(files, "/etc/apt/sources.list")
	}

	patterns := []string{
		"/etc/apt/sources.list.d/*.list",
		"/etc/apt/sources.list.d/*.sources",
	}
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return nil, err
		}
		files = append(files, matches...)
	}

	slices.Sort(files)
	return files, nil
}

func extractMirrorFromAPTList(content string) string {
	for _, line := range strings.Split(content, "\n") {
		if mirror := extractMirrorFromAPTListLine(line); mirror != "" {
			return mirror
		}
	}
	return ""
}

func extractMirrorFromAPTListLine(line string) string {
	fields := parseAPTListLineFields(line)
	if len(fields) == 0 {
		return ""
	}
	uriIndex := aptURIFieldIndex(fields)
	if uriIndex < 0 || uriIndex >= len(fields) {
		return ""
	}
	return fields[uriIndex]
}

func parseAPTListLineFields(line string) []string {
	content := strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
	if content == "" {
		return nil
	}

	fields := strings.Fields(content)
	if len(fields) == 0 {
		return nil
	}
	if fields[0] != "deb" && fields[0] != "deb-src" {
		return nil
	}

	return fields
}

func aptURIFieldIndex(fields []string) int {
	if len(fields) < 3 {
		return -1
	}

	idx := 1
	if strings.HasPrefix(fields[idx], "[") {
		for idx < len(fields) && !strings.HasSuffix(fields[idx], "]") {
			idx++
		}
		idx++
	}
	if idx >= len(fields) {
		return -1
	}
	return idx
}

func extractMirrorFromAPTSources(content string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToLower(trimmed), "uris:") {
			continue
		}
		return strings.TrimSpace(trimmed[len("URIs:"):])
	}
	return ""
}

func rewriteAPTListContent(content, distribution, mirror string) (string, bool) {
	lines := strings.Split(content, "\n")
	changed := false

	for i, line := range lines {
		updated, lineChanged := rewriteAPTListLine(line, distribution, mirror)
		if lineChanged {
			lines[i] = updated
			changed = true
		}
	}

	return strings.Join(lines, "\n"), changed
}

func rewriteAPTListLine(line, distribution, mirror string) (string, bool) {
	fields := parseAPTListLineFields(line)
	if len(fields) == 0 {
		return line, false
	}

	uriIndex := aptURIFieldIndex(fields)
	if uriIndex < 0 || uriIndex >= len(fields) {
		return line, false
	}

	currentURI := fields[uriIndex]
	suite := ""
	if uriIndex+1 < len(fields) {
		suite = fields[uriIndex+1]
	}
	targetURI := resolveAPTMirrorURI(distribution, mirror, currentURI, suite)
	if targetURI == "" || targetURI == currentURI {
		return line, false
	}

	fields[uriIndex] = targetURI
	comment := ""
	if parts := strings.SplitN(line, "#", 2); len(parts) == 2 {
		comment = "#" + parts[1]
	}

	updated := strings.Join(fields, " ")
	if comment != "" {
		updated += " " + strings.TrimSpace(comment)
	}
	return updated, true
}

// rewriteAPTSourcesContent 改写 deb822 格式（*.sources）里的 URIs。
//
// v3.3.1 起按「段」（空行分隔的 stanza）处理：先扫完整段拿到 Suites，再改这一段的 URIs。
// 原来是逐行往下读、遇到 URIs 时用「已经读到的 Suites」，可 Debian 官方的 debian.sources
// 里 URIs 恰恰写在 Suites 前面，那时拿到的永远是空串 —— security 段根本认不出来。
func rewriteAPTSourcesContent(content, distribution, mirror string) (string, bool) {
	lines := strings.Split(content, "\n")
	changed := false

	for start := 0; start < len(lines); {
		end := start
		for end < len(lines) && strings.TrimSpace(lines[end]) != "" {
			end++
		}

		suites := ""
		for _, line := range lines[start:end] {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(strings.ToLower(trimmed), "suites:") {
				suites = strings.TrimSpace(trimmed[len("Suites:"):])
			}
		}

		for i := start; i < end; i++ {
			line := lines[i]
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(strings.ToLower(trimmed), "uris:") {
				continue
			}

			currentURI := strings.TrimSpace(trimmed[len("URIs:"):])
			targetURI := resolveAPTMirrorURI(distribution, mirror, currentURI, suites)
			if targetURI == "" || targetURI == currentURI {
				continue
			}

			leading := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
			lines[i] = leading + "URIs: " + targetURI
			changed = true
		}

		start = end + 1
	}

	return strings.Join(lines, "\n"), changed
}

func resolveAPTMirrorURI(distribution, requestedMirror, currentURI, suites string) string {
	target := strings.TrimRight(strings.TrimSpace(requestedMirror), "/")
	if target == "" {
		target = strings.TrimRight(defaultLinuxMirror(LinuxPackageManager{Name: "apt", Binary: "apt-get"}, distribution), "/")
	}
	if target == "" {
		return ""
	}

	// Debian 的安全更新是单独的 debian-security 仓库（官方 deb.debian.org/debian-security、
	// security.debian.org/debian-security），阿里、清华、腾讯等镜像站也都是 <镜像>/debian-security。
	// 原来这一段也被改成 <镜像>/debian，而那下面没有 bookworm-security 的 Release，
	// apt-get update 会报 E:，安全更新源静默失效（安装脚本用 ; 串联，install 仍会继续，所以一直没人发现）。
	if isDebianSecurityAPTSource(distribution, currentURI, suites) && !strings.HasSuffix(target, "-security") {
		return target + "-security"
	}
	return target
}

// isDebianSecurityAPTSource 判断这一条源是不是 Debian 的安全更新仓库。
//
// 两条判据：URI 的路径以 -security 结尾（与发行版无关，路径本身就说明了一切）；
// 或者发行版是 Debian 且 Suites 里有 *-security（bookworm-security 这类）/ */updates（buster 及更早的写法）。
// Suites 这条刻意只认 Debian：Ubuntu 的 noble-security 就在 /ubuntu 下（官方 security.ubuntu.com/ubuntu），
// 加上 -security 后缀反而会指到一个不存在的路径。
func isDebianSecurityAPTSource(distribution, currentURI, suites string) bool {
	if strings.HasSuffix(strings.TrimRight(strings.TrimSpace(currentURI), "/"), "-security") {
		return true
	}
	if !strings.EqualFold(strings.TrimSpace(distribution), "debian") {
		return false
	}
	for _, suite := range strings.Fields(suites) {
		if strings.HasSuffix(suite, "-security") || strings.HasSuffix(suite, "/updates") {
			return true
		}
	}
	return false
}

func isHTTPMirror(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://")
}

func defaultLinuxMirror(manager LinuxPackageManager, distribution string) string {
	switch manager.Name {
	case "apk":
		return "https://mirrors.aliyun.com/alpine"
	case "apt":
		switch strings.ToLower(strings.TrimSpace(distribution)) {
		case "debian":
			return "https://mirrors.aliyun.com/debian"
		default:
			return "https://mirrors.aliyun.com/ubuntu"
		}
	default:
		return ""
	}
}

func isOfficialLinuxMirror(manager LinuxPackageManager, distribution, current string) bool {
	currentLower := strings.ToLower(strings.TrimRight(strings.TrimSpace(current), "/"))
	switch manager.Name {
	case "apk":
		return currentLower == "https://dl-cdn.alpinelinux.org/alpine" || currentLower == "http://dl-cdn.alpinelinux.org/alpine"
	case "apt":
		switch distribution {
		case "debian":
			return currentLower == "http://deb.debian.org/debian" ||
				currentLower == "https://deb.debian.org/debian" ||
				currentLower == "http://security.debian.org/debian-security" ||
				currentLower == "https://security.debian.org/debian-security"
		default:
			return currentLower == "http://archive.ubuntu.com/ubuntu" ||
				currentLower == "https://archive.ubuntu.com/ubuntu" ||
				currentLower == "http://security.ubuntu.com/ubuntu" ||
				currentLower == "https://security.ubuntu.com/ubuntu"
		}
	default:
		return false
	}
}
