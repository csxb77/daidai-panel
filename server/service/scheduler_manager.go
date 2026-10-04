package service

import (
	"log"
	"time"

	"daidai-panel/database"
	"daidai-panel/model"
)

var globalScheduler *SchedulerV2
var globalExecutor *TaskExecutor

// maxConcurrentTasksConfigKey 是「定时任务最大并发数」的配置键，
// 初始化与热生效两条路径共用，避免字面量拼写漂移。
const maxConcurrentTasksConfigKey = "max_concurrent_tasks"

// defaultSchedulerWorkerCount 是配置缺失或非法时的兜底并发数。
const defaultSchedulerWorkerCount = 4

// resolveSchedulerWorkerCount 读取配置里的并发数，非法值回落到兜底值。
func resolveSchedulerWorkerCount() int {
	workerCount := model.GetRegisteredConfigInt(maxConcurrentTasksConfigKey)
	if workerCount < 1 {
		return defaultSchedulerWorkerCount
	}
	return workerCount
}

// ApplySchedulerWorkerCount 让「定时任务最大并发数」在保存后立刻生效，不必重启面板。
// 调大立刻补 worker；调小时多余的 worker 只在两次任务之间退出，不会打断正在执行的任务。
func ApplySchedulerWorkerCount() {
	scheduler := globalScheduler
	if scheduler == nil {
		return
	}

	previous, applied := scheduler.SetWorkerCount(resolveSchedulerWorkerCount())
	if previous == applied {
		return
	}
	log.Printf("scheduler v2 concurrency limit updated: %d -> %d worker(s)", previous, applied)
}

func InitSchedulerV2() {
	globalExecutor = NewTaskExecutor()
	if count := RecoverAbandonedActiveTasks("面板上次异常退出，运行中的任务已标记为中断"); count > 0 {
		log.Printf("recovered %d abandoned active task(s)", count)
	}

	workerCount := resolveSchedulerWorkerCount()

	cfg := SchedulerConfig{
		WorkerCount: workerCount,
		// worker 会阻塞到任务执行结束，队列积压概率显著上升；
		// 队列容量与并发数解耦，取固定的较大值，避免正常波动就把请求丢掉。
		QueueSize:    1000,
		RateInterval: 200 * time.Millisecond,
	}

	globalScheduler = NewSchedulerV2(cfg, globalExecutor)
	globalScheduler.Start()

	var tasks []model.Task
	// 与 AddJob / ReloadAllJobs 的口径对齐：上面 RecoverAbandonedActiveTasks 已经把残留的
	// 排队中/运行中拉回启用态，这里再放宽一次是防御性的，避免三处条件各写各的以后漂移。
	database.DB.Where("status <> ?", model.TaskStatusDisabled).Find(&tasks)

	for _, task := range tasks {
		if err := globalScheduler.AddJob(&task); err != nil {
			log.Printf("任务 %d 启动时注册调度失败（它不会自动触发）: %v", task.ID, err)
		}
	}

	startupCount := globalScheduler.EnqueueStartupTasks()
	log.Printf("scheduler v2 initialized with %d tasks", len(tasks))
	if startupCount > 0 {
		log.Printf("scheduler v2 enqueued %d startup task(s)", startupCount)
	}
}

// schedulerShutdownWait 是关停时「等 worker 与执行收尾」两段等待合计的上限（原来是 5 秒 + 5 秒串行）。
// 任务进程已被整组杀掉，正常几十毫秒就能结算完；卡住的多半是逃出进程组、还攥着输出管道的孙进程，
// 再等也没用，交给 MarkActiveTasksInterrupted 兜底。与 HTTP 关停（5 秒）并行，整体压在面板 8 秒的总兜底里。
const schedulerShutdownWait = 4 * time.Second

// HaltSchedulerV2 是关停的第一步：不再触发、不再接新任务，并立即按进程组终止运行中的任务（runStopHalt）。
// 可重复调用：SignalStop 内部只执行一次，StopAllRunningTasks 第二次调用时进程表已经空了。
func HaltSchedulerV2() {
	// worker 会阻塞到任务结束，必须先中断执行中的进程，再回收 worker，
	// 否则每次关机都要白等满一个等待超时。
	if globalScheduler != nil {
		globalScheduler.SignalStop()
	}

	if globalExecutor != nil {
		killed := globalExecutor.StopAllRunningTasks()
		if killed > 0 {
			log.Printf("interrupted %d running task process(es) during panel shutdown", killed)
		}
	}
}

// ShutdownSchedulerV2 先 HaltSchedulerV2，再等 worker 与执行收尾，两段共用一个 4 秒的截止时间。
// 保持无参签名：二十多个测试用 t.Cleanup(ShutdownSchedulerV2) 收尾。
func ShutdownSchedulerV2() {
	HaltSchedulerV2()

	deadline := time.Now().Add(schedulerShutdownWait)
	remaining := func() time.Duration {
		// WaitWorkers / Wait 都把 <= 0 当成「一直等」，这里至少给 1 毫秒，绝不能变成无限等待。
		if left := time.Until(deadline); left > time.Millisecond {
			return left
		}
		return time.Millisecond
	}

	if globalScheduler != nil {
		if ok := globalScheduler.WaitWorkers(remaining()); !ok {
			log.Println("timed out waiting for scheduler workers to finish")
		}
		log.Println("scheduler v2 stopped")
	}

	if globalExecutor != nil {
		if ok := globalExecutor.Wait(remaining()); !ok {
			log.Println("timed out waiting for running task cleanup")
		}
		// 到了截止时间还没结算的执行，结算里那句吊销已经等不到了：这里先把它们注入脚本的面板凭据作废。
		// 不吊销的话，泄漏在临时目录里的那枚凭据有效期长达 7 天，jwt 密钥又存在数据目录里，面板重启后照样能用。
		// 都结算完时执行窗口已经空了，这里什么都不做。
		if revoked := globalExecutor.revokeUnsettledScriptTokens(); revoked > 0 {
			log.Printf("revoked %d script token(s) of unsettled task run(s) during shutdown", revoked)
		}
	}

	if count := MarkActiveTasksInterrupted("面板正在关闭或重启，任务已被中断"); count > 0 {
		log.Printf("marked %d active task(s) as interrupted during shutdown", count)
	}

	if globalScheduler != nil {
		globalScheduler = nil
	}
	globalExecutor = nil
}

func GetSchedulerV2() *SchedulerV2 {
	return globalScheduler
}

func GetTaskExecutor() *TaskExecutor {
	return globalExecutor
}
