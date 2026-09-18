package mcptools

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// 任务的新建与修改（#139）：对应 POST /tasks、PUT /tasks/:id。
// 运行、停止、启停与批量操作仍在 tools_write.go。
func (t *toolset) registerTaskWriteTools(s *mcp.Server) {
	addWriteTool(s, "create_task", "新建任务",
		"新建一个任务，建好即启用：task_type 为 cron（默认）时按 cron_expression 定时运行。command 与面板任务的「命令」一样，例如 task demo/sign.py。"+
			"注意 command 会以面板的权限执行，新建后可用 run_task 立即运行一次。",
		writeHints{}, t.createTask)
	addWriteTool(s, "update_task", "修改任务",
		"按 ID 修改任务配置，只改传入的字段（名称、命令、定时规则、类型、超时、标签等），原值被覆盖。脚本改名或移动后，可以用它同步任务的 command。",
		writeHints{destructive: true, idempotent: true}, t.updateTask)
}

// taskFields 是新建与修改共用的可选字段。指针为 nil、切片为 nil 表示没传：
// 修改时只发送传了的字段，面板按「传了才改」处理；labels 传空数组表示清空标签。
type taskFields struct {
	TaskType               *string  `json:"task_type,omitempty" jsonschema:"任务类型：cron（按定时规则运行，默认）、manual（只手动运行）、startup（面板启动时运行）"`
	CronExpression         *string  `json:"cron_expression,omitempty" jsonschema:"定时规则（5 段 cron，或带秒的 6 段；多条规则用换行分隔）。task_type 为 cron 时必填"`
	Timeout                *int     `json:"timeout,omitempty" jsonschema:"超时秒数，0 表示不限制"`
	Labels                 []string `json:"labels,omitempty" jsonschema:"标签列表，修改时整体替换，传空数组清空。分组就是「分组:名称」形式的标签"`
	PythonVersion          *string  `json:"python_version,omitempty" jsonschema:"运行 Python 脚本用的版本，例如 3.12；留空用面板默认版本"`
	MaxRetries             *int     `json:"max_retries,omitempty" jsonschema:"失败后自动重试的次数，0 表示不重试"`
	RetryInterval          *int     `json:"retry_interval,omitempty" jsonschema:"重试间隔秒数"`
	RandomDelaySeconds     *int     `json:"random_delay_seconds,omitempty" jsonschema:"定时触发后随机延迟的最大秒数（0 到 86400）"`
	SuccessExitCodes       *string  `json:"success_exit_codes,omitempty" jsonschema:"视为成功的退出码，逗号分隔，默认 0"`
	NotifyOnFailure        *bool    `json:"notify_on_failure,omitempty" jsonschema:"失败时发通知"`
	NotifyOnSuccess        *bool    `json:"notify_on_success,omitempty" jsonschema:"成功时发通知"`
	NotifyOnAbort          *bool    `json:"notify_on_abort,omitempty" jsonschema:"被终止时发通知"`
	TaskBefore             *string  `json:"task_before,omitempty" jsonschema:"每次运行前先执行的 shell 命令"`
	TaskAfter              *string  `json:"task_after,omitempty" jsonschema:"每次运行后再执行的 shell 命令"`
	AllowMultipleInstances *bool    `json:"allow_multiple_instances,omitempty" jsonschema:"上一次还没结束时，是否允许到点再启动一个实例"`
}

type createTaskInput struct {
	Name    string `json:"name" jsonschema:"任务名称"`
	Command string `json:"command" jsonschema:"要执行的命令，例如 task demo/sign.py"`
	taskFields
}

type updateTaskInput struct {
	ID      int64   `json:"id" jsonschema:"任务 ID，可从 list_tasks 获得"`
	Name    *string `json:"name,omitempty" jsonschema:"新的任务名称"`
	Command *string `json:"command,omitempty" jsonschema:"新的命令"`
	taskFields
}

var taskTypeValues = map[string]bool{"cron": true, "manual": true, "startup": true}

// addTo 把传了的字段写进请求体，并在发出请求前挡掉明显不对的取值。
func (f taskFields) addTo(body map[string]any) error {
	if f.TaskType != nil {
		taskType := strings.ToLower(strings.TrimSpace(*f.TaskType))
		if !taskTypeValues[taskType] {
			return fmt.Errorf("task_type 只能是 cron、manual、startup，收到 %q", *f.TaskType)
		}
		body["task_type"] = taskType
	}
	setIfPresent(body, "cron_expression", f.CronExpression)
	if f.Timeout != nil {
		if *f.Timeout < 0 {
			return errors.New("timeout 不能是负数")
		}
		body["timeout"] = *f.Timeout
	}
	if f.Labels != nil {
		labels := make([]string, 0, len(f.Labels))
		for _, label := range f.Labels {
			if label = strings.TrimSpace(label); label != "" {
				labels = append(labels, label)
			}
		}
		body["labels"] = labels
	}
	setIfPresent(body, "python_version", f.PythonVersion)
	setIfPresent(body, "max_retries", f.MaxRetries)
	setIfPresent(body, "retry_interval", f.RetryInterval)
	setIfPresent(body, "random_delay_seconds", f.RandomDelaySeconds)
	setIfPresent(body, "success_exit_codes", f.SuccessExitCodes)
	setIfPresent(body, "notify_on_failure", f.NotifyOnFailure)
	setIfPresent(body, "notify_on_success", f.NotifyOnSuccess)
	setIfPresent(body, "notify_on_abort", f.NotifyOnAbort)
	setIfPresent(body, "task_before", f.TaskBefore)
	setIfPresent(body, "task_after", f.TaskAfter)
	setIfPresent(body, "allow_multiple_instances", f.AllowMultipleInstances)
	return nil
}

// setIfPresent 只在调用方传了这个参数时写入请求体（任务、订阅的修改接口都是「传了才改」）。
func setIfPresent[T any](body map[string]any, key string, value *T) {
	if value != nil {
		body[key] = *value
	}
}

func (t *toolset) createTask(ctx context.Context, in createTaskInput) (any, error) {
	name := strings.TrimSpace(in.Name)
	command := strings.TrimSpace(in.Command)
	if name == "" || command == "" {
		return nil, errors.New("name 与 command 都不能为空")
	}
	body := map[string]any{"name": name, "command": command}
	if err := in.taskFields.addTo(body); err != nil {
		return nil, err
	}
	result, err := t.call(ctx, http.MethodPost, "/tasks", nil, body)
	if err != nil {
		return nil, err
	}
	return taskMutationOutput(result), nil
}

func (t *toolset) updateTask(ctx context.Context, in updateTaskInput) (any, error) {
	if err := requireID("id", in.ID); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			return nil, errors.New("name 不能改成空")
		}
		body["name"] = name
	}
	if in.Command != nil {
		command := strings.TrimSpace(*in.Command)
		if command == "" {
			return nil, errors.New("command 不能改成空")
		}
		body["command"] = command
	}
	if err := in.taskFields.addTo(body); err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, errors.New("没有要修改的字段：至少传一个 id 以外的参数")
	}
	result, err := t.call(ctx, http.MethodPut, fmt.Sprintf("/tasks/%d", in.ID), nil, body)
	if err != nil {
		return nil, err
	}
	return taskMutationOutput(result), nil
}

func taskMutationOutput(result map[string]any) map[string]any {
	out := map[string]any{"message": result["message"]}
	if task, ok := result["data"].(map[string]any); ok {
		out["task"] = taskDetail(task)
	}
	return out
}
