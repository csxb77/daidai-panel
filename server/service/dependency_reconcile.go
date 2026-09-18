package service

import (
	"log"
	"strings"

	"daidai-panel/database"
	"daidai-panel/model"
)

var dependencyInstalledFunc = DependencyInstalledForPythonVersion
var dependencyReinstallBatchFunc = reinstallDependenciesAsync
var dependencyRestartReinstallBatchFunc = reinstallDependenciesAfterRestartAsync

func ReconcileDependenciesAfterRestart() {
	var installed []model.Dependency
	database.DB.Where("status = ?", model.DepStatusInstalled).Find(&installed)
	reinstallAfterRestart := make([]model.Dependency, 0)
	scheduledRestartReinstallIDs := make(map[uint]struct{})

	for _, dep := range installed {
		if dependencyInstalledFunc(dep.Type, dep.Name, dep.PythonVersion) {
			continue
		}

		var logMsg string
		switch dep.Type {
		case model.DepTypeLinux:
			logMsg = "[启动校验] 检测到 Linux 依赖在容器重建后丢失，已在重启后自动重新安装"
		case model.DepTypeNodeJS:
			logMsg = "[启动校验] 检测到 Node.js 依赖丢失（可能因重启容器重建），已自动重新安装"
		case model.DepTypePython:
			logMsg = "[启动校验] 检测到 Python 依赖丢失（可能因重启容器重建），已自动重新安装"
		default:
			logMsg = "[启动校验] 依赖未检测到，已自动重新安装"
		}

		nextLog := appendDependencyLog(dep.Log, logMsg)
		database.DB.Model(&dep).Updates(map[string]interface{}{
			"status": model.DepStatusInstalling,
			"log":    nextLog,
		})
		dep.Status = model.DepStatusInstalling
		dep.Log = nextLog
		reinstallAfterRestart = append(reinstallAfterRestart, dep)
		scheduledRestartReinstallIDs[dep.ID] = struct{}{}
		log.Printf("dep verify: %s/%s missing after restart, scheduled automatic reinstall", dep.Type, dep.Name)
	}

	if len(reinstallAfterRestart) > 0 {
		dependencyRestartReinstallBatchFunc(reinstallAfterRestart)
		log.Printf("dep verify: scheduled %d missing dependencies for automatic reinstall after restart", len(reinstallAfterRestart))
	}

	// queued 也必须在这里收口：排队（一键安装 Playwright、批量重装）只活在进程内存里的那个协程中，
	// 面板一重启协程就没了，剩下的记录会永远停在 queued —— 删除、重装、取消、再点一键安装都把 queued
	// 当成「正在处理」拒掉，侧栏角标也一直亮着，用户没有任何办法把它们清掉。
	var stale []model.Dependency
	database.DB.Where("status IN ?", []string{model.DepStatusInstalling, model.DepStatusRemoving, model.DepStatusQueued}).Find(&stale)

	toResume := make([]model.Dependency, 0, len(stale))
	for _, dep := range stale {
		if _, exists := scheduledRestartReinstallIDs[dep.ID]; exists {
			continue
		}

		if dependencyInstalledFunc(dep.Type, dep.Name, dep.PythonVersion) {
			nextLog := appendDependencyLog(dep.Log, "[启动校验] 检测到依赖已安装，已同步状态为已安装")
			database.DB.Model(&dep).Updates(map[string]interface{}{
				"status": model.DepStatusInstalled,
				"log":    nextLog,
			})
			log.Printf("dep verify: %s/%s was %s, reconciled to installed", dep.Type, dep.Name, dep.Status)
			continue
		}

		// 排队中的记录一步都还没执行过，不自动续装而是置为 failed：保守、也不和别的恢复逻辑抢着装。
		// 用户再点一次一键安装（它会复用 failed 的记录）或逐条重装即可恢复。
		// 恢复备份续装那条分支只认 installing（shouldResumeRestoredDependency），不受影响。
		if dep.Status == model.DepStatusQueued {
			database.DB.Model(&dep).Updates(map[string]interface{}{
				"status": model.DepStatusFailed,
				"log":    appendDependencyLog(dep.Log, "[启动校验] 排队中的任务因服务重启而中断，未执行，可重新安装"),
			})
			log.Printf("dep verify: %s/%s was queued before restart, reset to failed", dep.Type, dep.Name)
			continue
		}

		if shouldResumeRestoredDependency(dep) {
			nextLog := appendDependencyLog(dep.Log, "[启动校验] 检测到恢复任务未完成，已在重启后继续安装")
			database.DB.Model(&dep).Updates(map[string]interface{}{
				"status": model.DepStatusInstalling,
				"log":    nextLog,
			})
			dep.Log = nextLog
			toResume = append(toResume, dep)
			log.Printf("dep verify: %s/%s was %s, resumed restore install after restart", dep.Type, dep.Name, dep.Status)
			continue
		}

		database.DB.Model(&dep).Updates(map[string]interface{}{
			"status": model.DepStatusFailed,
			"log":    appendDependencyLog(dep.Log, "[启动校验] 操作因服务重启而中断"),
		})
		log.Printf("dep verify: %s/%s was %s, reset to failed", dep.Type, dep.Name, dep.Status)
	}

	if len(toResume) > 0 {
		dependencyReinstallBatchFunc(toResume)
		log.Printf("dep verify: resumed %d restored dependencies after restart", len(toResume))
	}
}

func shouldResumeRestoredDependency(dep model.Dependency) bool {
	return dep.Status == model.DepStatusInstalling && strings.Contains(dep.Log, "[恢复备份]")
}

func appendDependencyLog(existing, line string) string {
	existing = strings.TrimRight(existing, "\n")
	line = strings.TrimSpace(line)
	if line == "" {
		return existing
	}
	if existing == "" {
		return line
	}
	if strings.Contains(existing, line) {
		return existing
	}
	return existing + "\n" + line
}
