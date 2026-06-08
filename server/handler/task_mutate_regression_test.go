package handler_test

import (
	"net/http"
	"testing"

	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

func TestCreateTaskDefaultsTimeoutToZero(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-create-default-timeout", "operator")
	token := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	rec := performJSONRequest(
		engine,
		http.MethodPost,
		"/api/v1/tasks",
		`{"name":"long running task","command":"echo ok","task_type":"manual"}`,
		map[string]string{"Authorization": "Bearer " + token},
		"",
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	payload := decodeJSONMap(t, rec)
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected task data object, got %#v", payload["data"])
	}
	if got := data["timeout"]; got != float64(0) {
		t.Fatalf("expected response timeout 0, got %#v", got)
	}

	var task model.Task
	if err := database.DB.First(&task, uint(data["id"].(float64))).Error; err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if task.Timeout != 0 {
		t.Fatalf("expected stored timeout 0, got %d", task.Timeout)
	}
}

func TestCreateTaskUsesConfiguredDefaultPythonVersionWhenOmitted(t *testing.T) {
	testutil.SetupTestEnv(t)

	if err := model.SetConfig("python_default_version", "3.11"); err != nil {
		t.Fatalf("set default python version: %v", err)
	}

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-create-default-python", "operator")
	token := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	rec := performJSONRequest(
		engine,
		http.MethodPost,
		"/api/v1/tasks",
		`{"name":"default python task","command":"task test.py","task_type":"manual"}`,
		map[string]string{"Authorization": "Bearer " + token},
		"",
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	payload := decodeJSONMap(t, rec)
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected task data object, got %#v", payload["data"])
	}
	if got := data["python_version"]; got != "3.11" {
		t.Fatalf("expected response python_version 3.11, got %#v", got)
	}

	var task model.Task
	if err := database.DB.First(&task, uint(data["id"].(float64))).Error; err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if task.PythonVersion != "3.11" {
		t.Fatalf("expected stored python_version 3.11, got %q", task.PythonVersion)
	}
}
