package service

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"daidai-panel/config"
	"daidai-panel/database"
	"daidai-panel/model"
)

const defaultPythonRuntimeVersion = "3.12"

var supportedPythonRuntimeVersions = []string{"3.10", "3.11", "3.12"}

type PythonRuntimeInfo struct {
	Version     string `json:"version"`
	Label       string `json:"label"`
	Default     bool   `json:"default"`
	VenvPath    string `json:"venv_path"`
	VenvHealthy bool   `json:"venv_healthy"`
	PythonPath  string `json:"python_path"`
	PipPath     string `json:"pip_path"`
	Available   bool   `json:"available"`
	Message     string `json:"message"`
}

func SupportedPythonVersions() []string {
	return append([]string(nil), supportedPythonRuntimeVersions...)
}

func LegacyPythonVersion() string {
	return defaultPythonRuntimeVersion
}

func NormalizeDependencyPythonVersion(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return LegacyPythonVersion()
	}
	return NormalizePythonVersionOrDefault(raw)
}

func NormalizePythonVersionStrict(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimPrefix(value, "python")
	value = strings.TrimPrefix(value, "py")
	value = strings.TrimSpace(value)
	switch value {
	case "", "3", "3.12", "312":
		if value == "" {
			return DefaultPythonVersion(), nil
		}
		return "3.12", nil
	case "3.10", "310":
		return "3.10", nil
	case "3.11", "311":
		return "3.11", nil
	default:
		return "", fmt.Errorf("Python 版本仅支持 3.10、3.11、3.12")
	}
}

func NormalizePythonVersionOrDefault(raw string) string {
	version, err := NormalizePythonVersionStrict(raw)
	if err != nil || strings.TrimSpace(version) == "" {
		return defaultPythonRuntimeVersion
	}
	return version
}

func DefaultPythonVersion() string {
	raw := ""
	if config.C != nil && config.C.Data.Dir != "" && database.DB != nil {
		raw = model.GetRegisteredConfig("python_default_version")
	}
	if strings.TrimSpace(raw) == "" {
		return defaultPythonRuntimeVersion
	}
	version, err := NormalizePythonVersionStrict(raw)
	if err != nil || version == "" {
		return defaultPythonRuntimeVersion
	}
	return version
}

func ResolvePythonVersionFromEnv(envVars map[string]string) string {
	if envVars == nil {
		return DefaultPythonVersion()
	}
	return NormalizePythonVersionOrDefault(envVars["DAIDAI_PYTHON_VERSION"])
}

func ResolvePythonVersionFromInterpreter(interpreter string) string {
	value := strings.ToLower(strings.TrimSpace(interpreter))
	switch value {
	case "python3.10":
		return "3.10"
	case "python3.11":
		return "3.11"
	case "python3.12":
		return "3.12"
	default:
		return ""
	}
}

func IsPythonInterpreter(interpreter string) bool {
	switch strings.ToLower(strings.TrimSpace(interpreter)) {
	case "python", "python3", "python3.10", "python3.11", "python3.12":
		return true
	default:
		return false
	}
}

func ManagedPythonVenvDir(version string) string {
	version = NormalizePythonVersionOrDefault(version)
	dataDir := ""
	if config.C != nil {
		dataDir = config.C.Data.Dir
	}
	pythonDir := filepath.Join(dataDir, "deps", "python")
	return filepath.Join(pythonDir, version)
}

func legacyManagedPythonVenvDir() string {
	dataDir := ""
	if config.C != nil {
		dataDir = config.C.Data.Dir
	}
	return filepath.Join(dataDir, "deps", "python", "venv")
}

func NormalizeLegacyPythonVersionColumns(version string) {
	if database.DB == nil {
		return
	}

	version = NormalizePythonVersionOrDefault(version)
	if err := database.DB.Exec("UPDATE dependencies SET python_version = ? WHERE type = ? AND (python_version IS NULL OR python_version = '')", version, model.DepTypePython).Error; err != nil {
		log.Printf("warn: failed to normalize legacy python dependency versions: %v", err)
	}
	if err := database.DB.Exec("UPDATE tasks SET python_version = ? WHERE python_version IS NULL OR python_version = ''", version).Error; err != nil {
		log.Printf("warn: failed to normalize legacy task python versions: %v", err)
	}
}

func NormalizeLegacyPythonVersionColumnsAfterVenvMigration(migration LegacyPythonVenvMigration) {
	version := NormalizePythonVersionOrDefault(migration.Version)
	NormalizeLegacyPythonVersionColumns(version)

	if !migration.MigratedRoot || version == defaultPythonRuntimeVersion || migration.DefaultVersionExisted || database.DB == nil {
		return
	}

	if err := database.DB.Exec("UPDATE dependencies SET python_version = ? WHERE type = ? AND python_version = ?", version, model.DepTypePython, defaultPythonRuntimeVersion).Error; err != nil {
		log.Printf("warn: failed to move legacy python dependency records to detected version %s: %v", version, err)
	}
	if err := database.DB.Exec("UPDATE tasks SET python_version = ? WHERE python_version = ?", version, defaultPythonRuntimeVersion).Error; err != nil {
		log.Printf("warn: failed to move legacy python task records to detected version %s: %v", version, err)
	}
	if strings.TrimSpace(model.GetRegisteredConfig("python_default_version")) == defaultPythonRuntimeVersion {
		if err := model.SetConfig("python_default_version", version); err != nil {
			log.Printf("warn: failed to update default python version to detected legacy version %s: %v", version, err)
		}
	}
}

func PythonRuntimeInfos() []PythonRuntimeInfo {
	defaultVersion := DefaultPythonVersion()
	infos := make([]PythonRuntimeInfo, 0, len(supportedPythonRuntimeVersions))
	for _, version := range supportedPythonRuntimeVersions {
		venvDir := ManagedPythonVenvDir(version)
		info := PythonRuntimeInfo{
			Version:     version,
			Label:       "Python " + version,
			Default:     version == defaultVersion,
			VenvPath:    venvDir,
			VenvHealthy: managedPythonVenvHealthyForVersion(venvDir, version),
		}
		if info.VenvHealthy {
			info.PythonPath = resolveManagedPythonBinaryInVenv(venvDir)
			info.PipPath = resolveManagedPipBinaryInVenv(venvDir)
			info.Available = true
			info.Message = "托管环境可用"
		} else if binary := discoverSystemPythonForVersion(version); binary != "" {
			info.PythonPath = binary
			info.Available = true
			info.Message = "检测到系统解释器，首次使用时会创建独立依赖环境"
		} else {
			info.Message = fmt.Sprintf("未检测到 Python %s，请先在服务器安装 python%s 或 Windows py -%s", version, version, version)
		}
		infos = append(infos, info)
	}
	return infos
}

func discoverSystemPythonForVersion(version string) string {
	for _, candidate := range managedPythonBootstrapCommandsForVersion(version) {
		if managedBootstrapCommandMatchesVersion(candidate, version) {
			return strings.Join(append([]string{candidate.binary}, candidate.versionArgsPrefix...), " ")
		}
	}
	return ""
}

func managedBootstrapCommandMatchesVersion(candidate managedBootstrapCommand, version string) bool {
	args := append([]string{}, candidate.versionArgsPrefix...)
	args = append(args, "--version")
	cmd := exec.Command(candidate.binary, args...)
	cmd.Env = appendPythonBootstrapEnv(SanitizePipEnv(os.Environ()))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	return pythonVersionOutputMatches(out, version)
}

func pythonVersionOutputMatches(out []byte, version string) bool {
	text := strings.ToLower(strings.TrimSpace(string(out)))
	return strings.Contains(text, "python "+version+".") || strings.Contains(text, "python "+version)
}

func windowsPythonPreferredDirsForVersion(version string) []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	suffix := strings.ReplaceAll(version, ".", "")
	dirs := []string{
		filepath.Join(os.Getenv("LocalAppData"), "Programs", "Python", "Python"+suffix),
		filepath.Join(os.Getenv("ProgramFiles"), "Python"+suffix),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Python"+suffix),
	}
	return append(dirs, windowsPythonPreferredDirs...)
}
