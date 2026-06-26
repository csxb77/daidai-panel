package service

import (
	"sync"
	"testing"

	"daidai-panel/model"
)

// 手动停止标记：打标记后消费一次返回 true，再次消费返回 false（读即清、幂等防残留）。
func TestConsumeManualStopMarkAndIdempotent(t *testing.T) {
	const taskID uint = 90001

	// 未打标记时消费应为 false。
	if consumeManualStop(taskID) {
		t.Fatalf("未打标记的任务消费应返回 false")
	}

	markManualStop(taskID)
	if !consumeManualStop(taskID) {
		t.Fatalf("打标记后首次消费应返回 true")
	}
	// 读即清：再次消费应为 false，避免残留误伤后续运行。
	if consumeManualStop(taskID) {
		t.Fatalf("标记已被消费，再次消费应返回 false")
	}
}

// 标记互不串扰：标记任务 A 不应影响任务 B 的判定。
func TestConsumeManualStopIsolatedPerTask(t *testing.T) {
	const taskA uint = 90002
	const taskB uint = 90003

	markManualStop(taskA)
	if consumeManualStop(taskB) {
		t.Fatalf("任务 B 未打标记，不应被任务 A 的标记影响")
	}
	if !consumeManualStop(taskA) {
		t.Fatalf("任务 A 应命中自己的标记")
	}
}

// 手动停止判成功：命中标记 -> 强制成功 + 抑制通知；
// 真实失败仍失败：未打标记 + 运行失败 -> 保持失败、不抑制通知。
func TestApplyManualStopOverride(t *testing.T) {
	const stoppedID uint = 90004
	const failedID uint = 90005
	const successID uint = 90006

	// 手动停止：即便本次运行结果是失败，也判成功并抑制通知。
	markManualStop(stoppedID)
	run, logStatus, suppress := applyManualStopOverride(stoppedID, model.RunFailed, model.LogStatusFailed)
	if run != model.RunSuccess || logStatus != model.LogStatusSuccess || !suppress {
		t.Fatalf("手动停止应判成功并抑制通知，got run=%d log=%d suppress=%v", run, logStatus, suppress)
	}
	// 标记应已被消费：再次调用按入参原样返回。
	run, logStatus, suppress = applyManualStopOverride(stoppedID, model.RunFailed, model.LogStatusFailed)
	if run != model.RunFailed || logStatus != model.LogStatusFailed || suppress {
		t.Fatalf("标记已消费后应原样返回失败、不抑制通知，got run=%d log=%d suppress=%v", run, logStatus, suppress)
	}

	// 真实失败（未打标记）：保持失败、不抑制通知。
	run, logStatus, suppress = applyManualStopOverride(failedID, model.RunFailed, model.LogStatusFailed)
	if run != model.RunFailed || logStatus != model.LogStatusFailed || suppress {
		t.Fatalf("真实失败应保持失败、不抑制通知，got run=%d log=%d suppress=%v", run, logStatus, suppress)
	}

	// 自然成功（未打标记）：保持成功、不抑制通知。
	run, logStatus, suppress = applyManualStopOverride(successID, model.RunSuccess, model.LogStatusSuccess)
	if run != model.RunSuccess || logStatus != model.LogStatusSuccess || suppress {
		t.Fatalf("自然成功应保持成功、不抑制通知，got run=%d log=%d suppress=%v", run, logStatus, suppress)
	}
}

// 并发打标记/消费应安全（sync.Map 保证），且每个标记最多被消费一次。
func TestManualStopConcurrentMarkConsume(t *testing.T) {
	const base uint = 91000
	const n = 200

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(id uint) {
			defer wg.Done()
			markManualStop(id)
		}(base + uint(i))
	}
	wg.Wait()

	var consumed int
	var mu sync.Mutex
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(id uint) {
			defer wg.Done()
			// 每个 id 两次消费，最多命中一次。
			hit := 0
			if consumeManualStop(id) {
				hit++
			}
			if consumeManualStop(id) {
				hit++
			}
			mu.Lock()
			consumed += hit
			mu.Unlock()
		}(base + uint(i))
	}
	wg.Wait()

	if consumed != n {
		t.Fatalf("每个标记应恰好被消费一次，期望 %d，实际 %d", n, consumed)
	}
}
