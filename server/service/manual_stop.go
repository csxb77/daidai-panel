package service

import (
	"sync"

	"daidai-panel/model"
)

// manualStopMarks 记录"手动停止"过的任务 ID。
//
// 手动停止（单个停止 / 批量停止 / 孤儿 PID 兜底）必须在杀进程之前打标记，
// 这样任务完成结算块运行时标记已可见，可把本次运行判为成功并跳过通知。
// key: taskID(uint) -> struct{}{}
var manualStopMarks sync.Map

// markManualStop 标记某任务本次运行为"手动停止"。
//
// 必须在杀进程之前调用，保证完成块运行时标记可见；重复标记安全（幂等）。
func markManualStop(taskID uint) {
	manualStopMarks.Store(taskID, struct{}{})
}

// MarkManualStop 是 markManualStop 的导出包装，供 handler 等其他包跨包调用。
func MarkManualStop(taskID uint) {
	markManualStop(taskID)
}

// consumeManualStop 读取并清除某任务的手动停止标记（读即清，LoadAndDelete 语义）。
//
// 返回 true 表示本次运行是被手动停止的。读即清保证幂等、不残留：
// 自然完成（未打标记）的任务消费时返回 false，行为完全不变。
func consumeManualStop(taskID uint) bool {
	_, ok := manualStopMarks.LoadAndDelete(taskID)
	return ok
}

// applyManualStopOverride 在任务完成结算时应用"手动停止判成功"规则。
//
// 它消费一次手动停止标记（读即清）：
//   - 命中标记：将运行状态与日志状态强制为成功，并返回 suppressNotify=true，
//     调用方据此跳过成功/失败两类通知。
//   - 未命中：原样返回传入的 runStatus / logStatus，suppressNotify=false。
//
// 这样两个完成块（执行器与旧调度器）共用同一套判定，自然失败仍判失败、仍发通知。
func applyManualStopOverride(taskID uint, runStatus, logStatus int) (finalRun int, finalLog int, suppressNotify bool) {
	if consumeManualStop(taskID) {
		return model.RunSuccess, model.LogStatusSuccess, true
	}
	return runStatus, logStatus, false
}
