package handler

import (
	"net/http"
	"strconv"
	"time"

	"daidai-panel/database"
	"daidai-panel/model"
	panelcron "daidai-panel/pkg/cron"
	"daidai-panel/pkg/response"
	"daidai-panel/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func validateAndEnableTask(task *model.Task) error {
	if task == nil {
		return nil
	}

	if task.UsesCronSchedule() {
		task.CronExpression = panelcron.NormalizeExpressions(task.CronExpression)
		if err := panelcron.ValidateExpressions(task.CronExpression); err != nil {
			return err
		}
	}

	// 之前如果在运行中禁用过、禁用还没落地，这次重新启用要把那笔意图撤掉，
	// 否则本次执行结束时仍会按「待禁用」结算，用户看到的就是「刚点了启用，跑完又变回禁用」。
	// 禁用中的任务被手动运行时 RunNow 打的也是这笔标记（issue #133），同样在这里撤掉。
	service.ClearPendingDisable(task.ID)

	inFlight := task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning
	if inFlight {
		// 排队中 / 运行中（典型场景：禁用任务被手动运行，issue #133 之后菜单会如实给出「启用」）
		// 不能把 status 直接写成启用：列表会立刻显示成空闲、停止按钮随之消失，可进程其实还在跑 ——
		// 与 disableTaskAndRemoveSchedule 里「运行中不能直接写禁用」是同一个坑的镜像。
		// 撤掉禁用意图、重新注册调度就够了：本次执行结算时 ResolveTaskInactiveStatus 看到「无标记 + 已注册」，自然落回启用。
		// 也不能整行 Save：执行器此刻正在写 pid / 运行态，整行写回会拿这份旧快照把它们盖掉。只补写规范化后的定时规则。
		if task.UsesCronSchedule() {
			if err := database.DB.Model(task).Update("cron_expression", task.CronExpression).Error; err != nil {
				return err
			}
		}
	} else {
		task.Status = model.TaskStatusEnabled
		if err := database.DB.Save(task).Error; err != nil {
			return err
		}
	}

	if scheduler := service.GetSchedulerV2(); scheduler != nil {
		if err := scheduler.AddJob(task); err != nil {
			return err
		}
	}

	if inFlight {
		// 竞态加固：上面走哪条分支，看的是调用方先读出来的快照。本次执行如果恰好在读库之后结算
		// （标记还在；或者撤标记之后、AddJob 之前走了 ResolveTaskInactiveStatus 的 !HasJob 兜底），
		// 库里已经落成禁用，而上面刚把定时触发注册回去 —— 库里禁用、cron 却是活的，要等下次触发才自愈。
		// 所以把「刚被结算成禁用」的行拉回启用。条件只认禁用：库里还是排队中 / 运行中时一律不碰，
		// 照旧由结算落回启用（直接写启用会让停止按钮消失，见上面的注释）。
		result := database.DB.Model(&model.Task{}).
			Where("id = ? AND status = ?", task.ID, model.TaskStatusDisabled).
			Update("status", model.TaskStatusEnabled)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected > 0 {
			// 启用接口拿这份快照回响应，跟着改，免得回一个已经不存在的「运行中」。
			task.Status = model.TaskStatusEnabled
		}
	}

	return nil
}

func disableTaskAndRemoveSchedule(task *model.Task) string {
	if task == nil {
		return "已禁用"
	}

	if scheduler := service.GetSchedulerV2(); scheduler != nil {
		scheduler.RemoveJob(task.ID)
	}

	if task.Status == model.TaskStatusRunning {
		// 运行中不能直接把 status 写成禁用（列表会立刻变成禁用、停止按钮消失，可进程还在跑），
		// 所以先记一笔意图，等本次执行结算时由 ResolveTaskInactiveStatus 落成禁用。
		service.MarkPendingDisable(task.ID)
		return "已设置为禁用，当前执行结束后生效"
	}

	task.Status = model.TaskStatusDisabled
	database.DB.Save(task)
	return "已禁用"
}

func (h *TaskHandler) Run(c *gin.Context) {
	taskID, _ := strconv.ParseUint(c.Param("id"), 10, 32)

	var task model.Task
	if err := database.DB.First(&task, taskID).Error; err != nil {
		response.NotFound(c, "任务不存在")
		return
	}

	if task.Status == model.TaskStatusRunning {
		response.BadRequest(c, "任务正在运行中")
		return
	}

	if err := service.GetSchedulerV2().RunNow(uint(taskID)); err != nil {
		response.Error(c, http.StatusServiceUnavailable, "任务入队失败: "+err.Error())
		return
	}
	response.Success(c, gin.H{"message": "任务已启动"})
}

func (h *TaskHandler) Stop(c *gin.Context) {
	taskID, _ := strconv.ParseUint(c.Param("id"), 10, 32)

	var task model.Task
	if err := database.DB.First(&task, taskID).Error; err != nil {
		response.NotFound(c, "任务不存在")
		return
	}

	stopped := false
	if executor := service.GetTaskExecutor(); executor != nil {
		stopped = executor.StopTask(uint(taskID))
	}
	if !stopped {
		if scheduler := service.GetScheduler(); scheduler != nil {
			stopped = scheduler.StopRunningTask(uint(taskID))
		}
	}

	hasRecordedPID := task.PID != nil && *task.PID > 0
	inFlight := task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning
	if !stopped && !hasRecordedPID && !inFlight {
		// 没在排队、没在运行，也没有任何可停的进程：什么都不改，直接告诉调用方。
		// 原来这里照样往下走，把 last_run_status 写成「已终止」—— 网页只在运行中才显示停止按钮，
		// 可开放 API / MCP 的 stop_task 能对任意 id 调，一调空闲任务的「上次结果」就被改掉了。
		// 上面两个 Stop 调用在没有登记进程时只是查一下（不打标记、不杀进程），先调它们没有副作用；
		// 登记着进程、或者库里记着 PID 的，照旧走下面的完整停止流程，排队中 / 运行中的语义都不变。
		response.Success(c, gin.H{"message": "任务未在运行"})
		return
	}

	if hasRecordedPID {
		// 兜底杀孤儿 PID 前也打"手动停止"标记，覆盖进程未被内存追踪的场景。
		service.MarkManualStop(uint(taskID))
		service.KillProcessByPid(*task.PID)
	}

	inactiveStatus := service.ResolveTaskInactiveStatus(&task)
	abortRunStatus := model.RunAborted
	database.DB.Model(&task).Updates(map[string]interface{}{
		"status":          inactiveStatus,
		"last_run_status": abortRunStatus,
		"pid":             gorm.Expr("NULL"),
		"log_path":        gorm.Expr("NULL"),
	})

	var runningLog model.TaskLog
	if err := database.DB.Where("task_id = ? AND status = ?", taskID, model.LogStatusRunning).
		Order("started_at DESC").First(&runningLog).Error; err == nil {
		now := time.Now()
		stopLogStatus := model.LogStatusAborted
		duration := now.Sub(runningLog.StartedAt).Seconds()
		if duration < 0 {
			duration = 0
		}
		// 主动停止立即标记为 Aborted；如果执行器随后完成，会按同一口径再次写入，不会冲突。
		database.DB.Model(&runningLog).Updates(map[string]interface{}{
			"status":   stopLogStatus,
			"ended_at": now,
			"duration": duration,
		})
		database.DB.Model(&task).Updates(map[string]interface{}{
			"last_run_status":   abortRunStatus,
			"last_running_time": duration,
		})
	}

	response.Success(c, gin.H{"message": "任务已停止"})
}

func (h *TaskHandler) Enable(c *gin.Context) {
	taskID, _ := strconv.ParseUint(c.Param("id"), 10, 32)

	var task model.Task
	if err := database.DB.First(&task, taskID).Error; err != nil {
		response.NotFound(c, "任务不存在")
		return
	}

	if err := validateAndEnableTask(&task); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.Success(c, gin.H{"message": "已启用", "data": taskDictWithEnabledSwitch(&task)})
}

func (h *TaskHandler) Disable(c *gin.Context) {
	taskID, _ := strconv.ParseUint(c.Param("id"), 10, 32)

	var task model.Task
	if err := database.DB.First(&task, taskID).Error; err != nil {
		response.NotFound(c, "任务不存在")
		return
	}

	message := disableTaskAndRemoveSchedule(&task)
	response.Success(c, gin.H{"message": message, "data": taskDictWithEnabledSwitch(&task)})
}
