package service

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"testing"
)

// 这几个启动钩子是否被接上、先后顺序对不对，单测直接调 service 函数是看不出来的：
// 把 appboot.go / main.go 里的调用删掉或调换顺序，其它用例照样全绿。这里按 AST 读源码核对
// （不做子串匹配，注释里提到函数名不算数）。

// collectCallNamesInFunc 按源码顺序列出 file 中顶层函数 funcName 里的所有调用，形如 service.Foo、verifyInstalledDeps。
func collectCallNamesInFunc(t *testing.T, file, funcName string) []string {
	t.Helper()
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	var body *ast.BlockStmt
	for _, decl := range parsed.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == funcName {
			body = fn.Body
			break
		}
	}
	if body == nil {
		t.Fatalf("function %s not found in %s", funcName, file)
	}

	type call struct {
		pos  token.Pos
		name string
	}
	var calls []call
	ast.Inspect(body, func(node ast.Node) bool {
		expr, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fun := expr.Fun.(type) {
		case *ast.Ident:
			calls = append(calls, call{pos: expr.Pos(), name: fun.Name})
		case *ast.SelectorExpr:
			if pkg, ok := fun.X.(*ast.Ident); ok {
				calls = append(calls, call{pos: expr.Pos(), name: pkg.Name + "." + fun.Sel.Name})
			}
		}
		return true
	})
	sort.SliceStable(calls, func(i, j int) bool { return calls[i].pos < calls[j].pos })
	names := make([]string, 0, len(calls))
	for _, c := range calls {
		names = append(names, c.name)
	}
	return names
}

// assertStartupCallOrder 要求 want 里每个调用恰好出现一次，并且按给定顺序排列。
func assertStartupCallOrder(t *testing.T, where string, calls []string, want ...string) {
	t.Helper()
	previous := -1
	for _, name := range want {
		index, count := -1, 0
		for i, got := range calls {
			if got == name {
				count++
				index = i
			}
		}
		if count != 1 {
			t.Fatalf("%s: expected %s to be called exactly once, found %d times (calls: %v)", where, name, count, calls)
		}
		if index <= previous {
			t.Fatalf("%s: expected call order %v, but %s comes too early (calls: %v)", where, want, name, calls)
		}
		previous = index
	}
}

// appboot：模块版 Python 迁移必须接在 single 策略之后、合并重复依赖之前。
// 删掉它，R4 的迁移就在生产里静默失效；挪到合并之后，迁移造成的同名重复要到下次开机才合并，
// 这一次开机的启动校验会看到同一个包两行记录。
func TestAppbootWiresMagiskPythonMigrationBeforeDuplicateMerge(t *testing.T) {
	calls := collectCallNamesInFunc(t, "../appboot/appboot.go", "InitWithConfig")
	assertStartupCallOrder(t, "appboot.InitWithConfig", calls,
		"service.ApplySinglePythonRuntimePolicyOnStartup",
		"service.ApplyMagiskPythonRuntimeMigrationOnStartup",
		"service.MergeDuplicatePythonDependencies",
	)
}

// main：Playwright 浏览器目录（#142）要在 config / 数据库就绪之后、启动校验排队重装依赖之前写进进程环境。
// 删掉它，系统命令行与依赖安装子进程会把浏览器下到容器可写层，重建即丢；挪到启动校验之后，
// 第一批重装的 pip 子进程就拿不到这个目录。
func TestMainWiresPlaywrightBrowsersPathBeforeDependencyVerification(t *testing.T) {
	calls := collectCallNamesInFunc(t, "../main.go", "main")
	assertStartupCallOrder(t, "main", calls,
		"appboot.InitWithConfig",
		"service.ApplyPlaywrightBrowsersPathProcessEnv",
		"verifyInstalledDeps",
	)
}

// main：Node ABI 重建检查接在启动校验之后。删掉它，换 Node 大版本后加载失败的原生扩展就不会自动修复。
func TestMainWiresNodeABIRebuildAfterDependencyVerification(t *testing.T) {
	calls := collectCallNamesInFunc(t, "../main.go", "main")
	assertStartupCallOrder(t, "main", calls,
		"appboot.InitWithConfig",
		"verifyInstalledDeps",
		"service.RebuildNodeDependenciesIfABIChanged",
	)
}
