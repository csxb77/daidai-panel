package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"daidai-panel/config"
	"daidai-panel/testutil"
)

func TestEnsureNodePackageManifestRepairsBrokenPackageJSON(t *testing.T) {
	testutil.SetupTestEnv(t)

	nodeDir := filepath.Join(config.C.Data.Dir, "deps", "nodejs")
	moduleDir := filepath.Join(nodeDir, "node_modules", "axios")
	if err := os.MkdirAll(moduleDir, 0o755); err != nil {
		t.Fatalf("create node module dir: %v", err)
	}

	// 模拟截图里的 EJSONPARSE：package.json 末尾多了一个 `}`，npm install 会直接失败。
	brokenPackageJSON := "{\n  \"dependencies\": {\n    \"axios\": \"^1.7.0\"\n  }\n}\n}\n"
	if err := os.WriteFile(filepath.Join(nodeDir, "package.json"), []byte(brokenPackageJSON), 0o644); err != nil {
		t.Fatalf("write broken package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "package.json"), []byte(`{"name":"axios","version":"1.7.9"}`), 0o644); err != nil {
		t.Fatalf("write module package.json: %v", err)
	}

	if err := ensureNodePackageManifest(nodeDir); err != nil {
		t.Fatalf("repair node package manifest: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(nodeDir, "package.json"))
	if err != nil {
		t.Fatalf("read repaired package.json: %v", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("package.json should be valid JSON after repair: %v\n%s", err, string(data))
	}

	deps, ok := manifest["dependencies"].(map[string]any)
	if !ok {
		t.Fatalf("expected dependencies object after repair, got %#v", manifest["dependencies"])
	}
	if deps["axios"] != "^1.7.9" {
		t.Fatalf("expected axios dependency to be rebuilt from node_modules, got %#v", deps["axios"])
	}

	backups, err := filepath.Glob(filepath.Join(nodeDir, "package.json.broken-*"))
	if err != nil {
		t.Fatalf("glob broken backups: %v", err)
	}
	if len(backups) != 1 {
		t.Fatalf("expected one broken package.json backup, got %d", len(backups))
	}
	backupData, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatalf("read broken backup: %v", err)
	}
	if strings.TrimSpace(string(backupData)) != strings.TrimSpace(brokenPackageJSON) {
		t.Fatalf("broken backup should preserve original content, got:\n%s", string(backupData))
	}
}
