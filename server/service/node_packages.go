package service

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"daidai-panel/config"
)

var nodePackageOperationMu sync.Mutex

// LockNodePackageOperation 串行化 npm install / uninstall。
// npm 会同时改 package.json / package-lock.json，并发执行时很容易把 JSON 写坏。
func LockNodePackageOperation() func() {
	nodePackageOperationMu.Lock()
	return nodePackageOperationMu.Unlock
}

func NewNpmInstallCommand(packageName string) (*exec.Cmd, error) {
	nodeDir := filepath.Join(config.C.Data.Dir, "deps", "nodejs")
	if err := ensureNodePackageManifest(nodeDir); err != nil {
		return nil, err
	}

	cmd := exec.Command("npm", "install", "--prefix", nodeDir, packageName)
	cmd.Env = NpmInstallEnv(AppendProxyEnv(os.Environ()), CurrentNpmMirror())
	return cmd, nil
}

func NewNpmUninstallCommand(packageName string, force bool) (*exec.Cmd, error) {
	nodeDir := filepath.Join(config.C.Data.Dir, "deps", "nodejs")
	if err := ensureNodePackageManifest(nodeDir); err != nil {
		return nil, err
	}

	args := []string{"uninstall", "--prefix", nodeDir}
	if force {
		args = append(args, "--force")
	}
	args = append(args, packageName)

	cmd := exec.Command("npm", args...)
	cmd.Env = NpmInstallEnv(AppendProxyEnv(os.Environ()), CurrentNpmMirror())
	return cmd, nil
}

func ensureNodePackageManifest(nodeDir string) error {
	if err := os.MkdirAll(nodeDir, 0o755); err != nil {
		return fmt.Errorf("创建 Node.js 依赖目录失败: %w", err)
	}

	packageJSONPath := filepath.Join(nodeDir, "package.json")
	data, err := os.ReadFile(packageJSONPath)
	if os.IsNotExist(err) {
		return writeNodePackageManifest(packageJSONPath, collectInstalledNodeDependencies(nodeDir))
	}
	if err != nil {
		return fmt.Errorf("读取 Node.js package.json 失败: %w", err)
	}

	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err == nil && manifest != nil {
		if depsValue, exists := manifest["dependencies"]; exists {
			if _, ok := depsValue.(map[string]any); !ok {
				return backupAndRewriteNodePackageManifest(packageJSONPath, nodeDir)
			}
		}
		return nil
	}

	return backupAndRewriteNodePackageManifest(packageJSONPath, nodeDir)
}

func backupAndRewriteNodePackageManifest(packageJSONPath, nodeDir string) error {
	backupPath := packageJSONPath + ".broken-" + time.Now().Format("20060102150405")
	for index := 1; ; index++ {
		if _, err := os.Stat(backupPath); os.IsNotExist(err) {
			break
		}
		backupPath = fmt.Sprintf("%s.broken-%s-%d", packageJSONPath, time.Now().Format("20060102150405"), index)
	}

	// 先备份坏文件，方便用户后续排查；再根据 node_modules 重建一个 npm 能解析的最小 package.json。
	if err := os.Rename(packageJSONPath, backupPath); err != nil {
		return fmt.Errorf("备份损坏的 Node.js package.json 失败: %w", err)
	}
	if err := writeNodePackageManifest(packageJSONPath, collectInstalledNodeDependencies(nodeDir)); err != nil {
		return err
	}
	return nil
}

func writeNodePackageManifest(packageJSONPath string, dependencies map[string]string) error {
	manifest := map[string]any{
		"private":      true,
		"dependencies": dependencies,
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("生成 Node.js package.json 失败: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(packageJSONPath, data, 0o644); err != nil {
		return fmt.Errorf("写入 Node.js package.json 失败: %w", err)
	}
	return nil
}

func collectInstalledNodeDependencies(nodeDir string) map[string]string {
	dependencies := map[string]string{}
	nodeModulesDir := filepath.Join(nodeDir, "node_modules")
	entries, err := os.ReadDir(nodeModulesDir)
	if err != nil {
		return dependencies
	}

	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		if strings.HasPrefix(entry.Name(), "@") {
			scopeDir := filepath.Join(nodeModulesDir, entry.Name())
			scopeEntries, err := os.ReadDir(scopeDir)
			if err != nil {
				continue
			}
			for _, scopeEntry := range scopeEntries {
				if !scopeEntry.IsDir() || strings.HasPrefix(scopeEntry.Name(), ".") {
					continue
				}
				fallbackName := filepath.ToSlash(filepath.Join(entry.Name(), scopeEntry.Name()))
				addInstalledNodeDependency(dependencies, filepath.Join(scopeDir, scopeEntry.Name()), fallbackName)
			}
			continue
		}

		addInstalledNodeDependency(dependencies, filepath.Join(nodeModulesDir, entry.Name()), entry.Name())
	}

	return dependencies
}

func addInstalledNodeDependency(dependencies map[string]string, moduleDir, fallbackName string) {
	data, err := os.ReadFile(filepath.Join(moduleDir, "package.json"))
	if err != nil {
		return
	}

	var pkg struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return
	}

	name := strings.TrimSpace(pkg.Name)
	if name == "" {
		name = strings.TrimSpace(filepath.ToSlash(fallbackName))
	}
	if name == "" {
		return
	}

	version := strings.TrimSpace(pkg.Version)
	if version == "" {
		dependencies[name] = "*"
		return
	}
	dependencies[name] = "^" + version
}
