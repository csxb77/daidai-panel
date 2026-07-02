package handler_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

func TestStopTaskUsesStopAsFailureForRunningLogStatus(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-stop-outcome", "operator")
	token := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	tests := []struct {
		name          string
		stopAsFailure bool
		wantLogStatus int
	}{
		{name: "默认终止算成功", stopAsFailure: false, wantLogStatus: model.LogStatusSuccess},
		{name: "开启后终止算失败", stopAsFailure: true, wantLogStatus: model.LogStatusFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			startedAt := time.Now().Add(-time.Minute)
			task := &model.Task{
				Name:          tt.name,
				Command:       "echo running",
				TaskType:      model.TaskTypeManual,
				Status:        model.TaskStatusRunning,
				StopAsFailure: tt.stopAsFailure,
			}
			if err := database.DB.Create(task).Error; err != nil {
				t.Fatalf("create task: %v", err)
			}
			runningStatus := model.LogStatusRunning
			logRecord := &model.TaskLog{
				TaskID:    task.ID,
				Status:    &runningStatus,
				StartedAt: startedAt,
			}
			if err := database.DB.Create(logRecord).Error; err != nil {
				t.Fatalf("create task log: %v", err)
			}

			rec := performJSONRequest(
				engine,
				http.MethodPut,
				fmt.Sprintf("/api/v1/tasks/%d/stop", task.ID),
				`{}`,
				map[string]string{"Authorization": "Bearer " + token},
				"",
			)
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
			}

			var updatedLog model.TaskLog
			if err := database.DB.First(&updatedLog, logRecord.ID).Error; err != nil {
				t.Fatalf("reload task log: %v", err)
			}
			if updatedLog.Status == nil || *updatedLog.Status != tt.wantLogStatus {
				t.Fatalf("expected log status %d, got %#v", tt.wantLogStatus, updatedLog.Status)
			}
			if updatedLog.EndedAt == nil {
				t.Fatalf("expected ended_at after stop")
			}
		})
	}
}
