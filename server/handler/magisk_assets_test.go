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
