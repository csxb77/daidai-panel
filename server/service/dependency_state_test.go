package service

import (
	"os"
	"path/filepath"
	"testing"

	"daidai-panel/config"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

func TestNormalizeNodeDependencyPackageName(t *testing.T) {
	tests := map[string]string{
		"chalk":                    "chalk",
		"chalk@4.1.2":              "chalk",
		"http-proxy-agent@7.0.0":   "http-proxy-agent",
		"@scope/pkg":               "@scope/pkg",
		"@scope/pkg@1.2.3":         "@scope/pkg",
		"@scope/pkg-beta@^2.0.0":   "@scope/pkg-beta",
		"@scope/pkg/subpath@1.2.3": "@scope/pkg/subpath",
	}

	for input, expected := range tests {
		if got := NormalizeNodeDependencyPackageName(input); got != expected {
			t.Fatalf("NormalizeNodeDependencyPackageName(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestDependencyInstalledNodeJSAcceptsVersionSpec(t *testing.T) {
	testutil.SetupTestEnv(t)

	for _, pkg := range []string{
		filepath.Join(config.C.Data.Dir, "deps", "nodejs", "node_modules", "http-proxy-agent"),
		filepath.Join(config.C.Data.Dir, "deps", "nodejs", "node_modules", "@scope", "pkg"),
	} {
		if err := os.MkdirAll(pkg, 0o755); err != nil {
			t.Fatalf("mkdir node dependency: %v", err)
		}
	}

	if !DependencyInstalledForPythonVersion(model.DepTypeNodeJS, "http-proxy-agent@7.0.0", "") {
		t.Fatal("expected versioned node dependency to be detected as installed")
	}
	if !DependencyInstalledForPythonVersion(model.DepTypeNodeJS, "@scope/pkg@1.2.3", "") {
		t.Fatal("expected scoped versioned node dependency to be detected as installed")
	}
}
