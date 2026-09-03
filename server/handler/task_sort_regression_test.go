package handler_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

// 从任务列表响应里按返回顺序取出任务名。拖拽与列排序的用例校验的都是【顺序】，
// 所以不能像老用例那样只做 contains 判定，必须逐条按下标比。
func taskListNamesInOrder(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()

	payload := decodeJSONMap(t, rec)
	items, ok := payload["data"].([]interface{})
	if !ok {
		t.Fatalf("expected data array, got %#v", payload["data"])
	}

	names := make([]string, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok {
			t.Fatalf("expected task object, got %#v", raw)
		}
		name, _ := item["name"].(string)
		names = append(names, name)
	}
	return names
}

// 取任务列表响应里每条的 next_run_at。没有这个键（禁用 / 非 cron 任务）时放一个 nil，
// 用来断言「算不出下次运行的任务恒排最后」。
func taskListNextRunTimesInOrder(t *testing.T, rec *httptest.ResponseRecorder) []*time.Time {
	t.Helper()

	payload := decodeJSONMap(t, rec)
	items, ok := payload["data"].([]interface{})
	if !ok {
		t.Fatalf("expected data array, got %#v", payload["data"])
	}

	times := make([]*time.Time, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok {
			t.Fatalf("expected task object, got %#v", raw)
		}
		text, ok := item["next_run_at"].(string)
		if !ok || text == "" {
			times = append(times, nil)
			continue
		}
		parsed, err := time.Parse(time.RFC3339, text)
		if err != nil {
			t.Fatalf("parse next_run_at %q: %v", text, err)
		}
		times = append(times, &parsed)
	}
	return times
}

// 拖拽只允许写 list_order。同桶拖拽后整桶按 (idx+1)*10 重编号，且列表首位换成被拖的那条。
func TestTaskSortWithinBucketRenumbersListOrder(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	tasks := make([]*model.Task, 0, 3)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		task := &model.Task{
			Name:           name,
			Command:        "task demo.py",
			CronExpression: "0 0 * * *",
			Status:         model.TaskStatusEnabled,
		}
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", name, err)
		}
		tasks = append(tasks, task)
	}

	// 默认序里同桶按 created_at DESC / id DESC，所以初始展示是 gamma、beta、alpha。
	// 把 alpha 拖到 gamma 前面，期望变成 alpha、gamma、beta。
	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d,"target_id":%d,"position":"before"}`, tasks[0].ID, tasks[2].ID),
		map[string]string{"Authorization": "Bearer " + accessToken},
		"",
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	wantListOrder := map[uint]int{
		tasks[0].ID: 10,
		tasks[2].ID: 20,
		tasks[1].ID: 30,
	}
	for id, want := range wantListOrder {
		var current model.Task
		if err := database.DB.First(&current, id).Error; err != nil {
			t.Fatalf("reload task %d: %v", id, err)
		}
		if current.ListOrder != want {
			t.Fatalf("任务 %q 的 list_order 应为 %d，实际 %d", current.Name, want, current.ListOrder)
		}
		// 拖拽绝不能碰 sort_order —— 它是开机任务的串行执行顺序契约。
		if current.SortOrder != 0 {
			t.Fatalf("拖拽不应改动 sort_order，任务 %q 变成了 %d", current.Name, current.SortOrder)
		}
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/tasks", map[string]string{
		"Authorization": "Bearer " + accessToken,
	})
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list 200, got %d: %s", listRec.Code, listRec.Body.String())
	}
	gotNames := taskListNamesInOrder(t, listRec)
	wantNames := []string{"alpha", "gamma", "beta"}
	for i, want := range wantNames {
		if i >= len(gotNames) || gotNames[i] != want {
			t.Fatalf("expected order %v, got %v", wantNames, gotNames)
		}
	}
}

// 省略 target_id = 移到本桶末尾。
func TestTaskSortWithoutTargetMovesToBucketEnd(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-tail-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	tasks := make([]*model.Task, 0, 3)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		task := &model.Task{
			Name:           name,
			Command:        "task demo.py",
			CronExpression: "0 0 * * *",
			Status:         model.TaskStatusEnabled,
		}
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", name, err)
		}
		tasks = append(tasks, task)
	}

	// 初始展示 gamma、beta、alpha；把 gamma 不带目标地拖走，应落到末尾变成 beta、alpha、gamma。
	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d}`, tasks[2].ID),
		map[string]string{"Authorization": "Bearer " + accessToken},
		"",
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/tasks", map[string]string{
		"Authorization": "Bearer " + accessToken,
	})
	gotNames := taskListNamesInOrder(t, listRec)
	wantNames := []string{"beta", "alpha", "gamma"}
	for i, want := range wantNames {
		if i >= len(gotNames) || gotNames[i] != want {
			t.Fatalf("expected order %v, got %v", wantNames, gotNames)
		}
	}

	var moved model.Task
	if err := database.DB.First(&moved, tasks[2].ID).Error; err != nil {
		t.Fatalf("reload moved task: %v", err)
	}
	if moved.ListOrder != 30 {
		t.Fatalf("末尾那条的 list_order 应为 30，实际 %d", moved.ListOrder)
	}
}

// 跨页拖拽：兄弟列表是从数据库取整桶而不是当前页，所以把第 3 页的任务拖到第 1 页也能算对位置。
func TestTaskSortWorksAcrossPages(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-paging-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	tasks := make([]*model.Task, 0, 5)
	for _, name := range []string{"t1", "t2", "t3", "t4", "t5"} {
		task := &model.Task{
			Name:           name,
			Command:        "task demo.py",
			CronExpression: "0 0 * * *",
			Status:         model.TaskStatusEnabled,
		}
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", name, err)
		}
		tasks = append(tasks, task)
	}

	// 初始展示 t5、t4、t3、t2、t1；page_size=2 时 t1 在第 3 页。把它拖到第 1 页的 t5 前面。
	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d,"target_id":%d,"position":"before"}`, tasks[0].ID, tasks[4].ID),
		map[string]string{"Authorization": "Bearer " + accessToken},
		"",
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/tasks?page=1&page_size=2", map[string]string{
		"Authorization": "Bearer " + accessToken,
	})
	gotNames := taskListNamesInOrder(t, listRec)
	wantNames := []string{"t1", "t5"}
	if len(gotNames) != 2 || gotNames[0] != wantNames[0] || gotNames[1] != wantNames[1] {
		t.Fatalf("expected first page %v, got %v", wantNames, gotNames)
	}
}

// 跨置顶区、跨状态分组一律 400，且一个字都不许写库。
func TestTaskSortRejectsCrossBucketDrag(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-bucket-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	pinned := &model.Task{Name: "pinned", Command: "task a.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, IsPinned: true}
	enabled := &model.Task{Name: "enabled", Command: "task b.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled}
	disabled := &model.Task{Name: "disabled", Command: "task c.py", CronExpression: "0 0 * * *", Status: model.TaskStatusDisabled}
	for _, task := range []*model.Task{pinned, enabled, disabled} {
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", task.Name, err)
		}
	}

	cases := []struct {
		name     string
		sourceID uint
		targetID uint
	}{
		{name: "普通任务拖进置顶区", sourceID: enabled.ID, targetID: pinned.ID},
		{name: "禁用任务拖进启用区", sourceID: disabled.ID, targetID: enabled.ID},
	}
	for _, tc := range cases {
		rec := performJSONRequest(
			engine,
			http.MethodPut,
			"/api/v1/tasks/sort",
			fmt.Sprintf(`{"source_id":%d,"target_id":%d}`, tc.sourceID, tc.targetID),
			map[string]string{"Authorization": "Bearer " + accessToken},
			"",
		)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s：expected 400, got %d: %s", tc.name, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "分别排序") {
			t.Fatalf("%s：expected cross-bucket hint, got %s", tc.name, rec.Body.String())
		}
	}

	// 被拒绝的请求不能留下半截写入：三条任务的 list_order 都必须还是补列后的 0。
	for _, id := range []uint{pinned.ID, enabled.ID, disabled.ID} {
		var current model.Task
		if err := database.DB.First(&current, id).Error; err != nil {
			t.Fatalf("reload task %d: %v", id, err)
		}
		if current.ListOrder != 0 {
			t.Fatalf("跨桶拖拽被拒绝后不该写库，任务 %q 的 list_order 变成了 %d", current.Name, current.ListOrder)
		}
	}
}

// 拖到自己身上（前端抖一下就会发出来）必须是纯幂等，不能顺手把整桶重编号一遍。
func TestTaskSortSameSourceAndTargetKeepsListOrder(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-noop-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	first := &model.Task{Name: "first", Command: "task a.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, ListOrder: 5}
	second := &model.Task{Name: "second", Command: "task b.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, ListOrder: 7}
	for _, task := range []*model.Task{first, second} {
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", task.Name, err)
		}
	}

	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d,"target_id":%d}`, first.ID, first.ID),
		map[string]string{"Authorization": "Bearer " + accessToken},
		"",
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	wantListOrder := map[uint]int{first.ID: 5, second.ID: 7}
	for id, want := range wantListOrder {
		var current model.Task
		if err := database.DB.First(&current, id).Error; err != nil {
			t.Fatalf("reload task %d: %v", id, err)
		}
		if current.ListOrder != want {
			t.Fatalf("拖到自己身上不该重编号，任务 %q 的 list_order 从 %d 变成了 %d", current.Name, want, current.ListOrder)
		}
	}
}

// 排序接口是 operator 权限，viewer 调用必须 403。
func TestTaskSortRejectsViewerRole(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	viewer := testutil.MustCreateUser(t, "task-sort-viewer", "viewer")
	viewerToken := testutil.MustCreateAccessToken(t, viewer.Username, viewer.Role)

	task := &model.Task{Name: "alpha", Command: "task a.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled}
	if err := database.DB.Create(task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}

	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d}`, task.ID),
		map[string]string{"Authorization": "Bearer " + viewerToken},
		"",
	)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer, got %d: %s", rec.Code, rec.Body.String())
	}
}

// 拖过之后再不带 sort_rules 查列表，置顶区与禁用分组仍然优先于拖拽顺序。
// list_order 只在同一个桶内部生效，不能把置顶任务顶下去、也不能把禁用任务顶上来。
func TestTaskListKeepsPinnedAndStatusGroupingAfterDrag(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-sort-grouping-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	pinned := &model.Task{Name: "pinned", Command: "task p.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, IsPinned: true}
	alpha := &model.Task{Name: "alpha", Command: "task a.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled}
	beta := &model.Task{Name: "beta", Command: "task b.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled}
	disabled := &model.Task{Name: "disabled", Command: "task d.py", CronExpression: "0 0 * * *", Status: model.TaskStatusDisabled}
	for _, task := range []*model.Task{pinned, alpha, beta, disabled} {
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", task.Name, err)
		}
	}

	// 普通启用区初始展示是 beta、alpha，把 alpha 拖到 beta 前面。
	rec := performJSONRequest(
		engine,
		http.MethodPut,
		"/api/v1/tasks/sort",
		fmt.Sprintf(`{"source_id":%d,"target_id":%d}`, alpha.ID, beta.ID),
		map[string]string{"Authorization": "Bearer " + accessToken},
		"",
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// 禁用任务不在被拖的那个桶里，list_order 必须保持存量的 0。
	var currentDisabled model.Task
	if err := database.DB.First(&currentDisabled, disabled.ID).Error; err != nil {
		t.Fatalf("reload disabled task: %v", err)
	}
	if currentDisabled.ListOrder != 0 {
		t.Fatalf("重编号只该动本桶，禁用任务的 list_order 变成了 %d", currentDisabled.ListOrder)
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/tasks", map[string]string{
		"Authorization": "Bearer " + accessToken,
	})
	gotNames := taskListNamesInOrder(t, listRec)
	wantNames := []string{"pinned", "alpha", "beta", "disabled"}
	for i, want := range wantNames {
		if i >= len(gotNames) || gotNames[i] != want {
			t.Fatalf("expected order %v, got %v", wantNames, gotNames)
		}
	}
}

// 「最后运行」列排序：升降序都生效，从未运行过的任务恒排最后、不跟随方向翻转。
func TestTaskListSortsByLastRunAtWithNeverRunLast(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-last-run-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	older := time.Now().Add(-2 * time.Hour)
	newer := time.Now().Add(-1 * time.Hour)
	tasks := []*model.Task{
		{Name: "ran-older", Command: "task a.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, LastRunAt: &older},
		{Name: "ran-newer", Command: "task b.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled, LastRunAt: &newer},
		{Name: "never-run", Command: "task c.py", CronExpression: "0 0 * * *", Status: model.TaskStatusEnabled},
	}
	for _, task := range tasks {
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", task.Name, err)
		}
	}

	cases := []struct {
		direction string
		want      []string
	}{
		{direction: "asc", want: []string{"ran-older", "ran-newer", "never-run"}},
		{direction: "desc", want: []string{"ran-newer", "ran-older", "never-run"}},
	}
	for _, tc := range cases {
		sortJSON := fmt.Sprintf(`[{"field":"last_run_at","direction":"%s"}]`, tc.direction)
		rec := performRequest(engine, http.MethodGet, "/api/v1/tasks?sort_rules="+url.QueryEscape(sortJSON), map[string]string{
			"Authorization": "Bearer " + accessToken,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s：expected status 200, got %d: %s", tc.direction, rec.Code, rec.Body.String())
		}
		gotNames := taskListNamesInOrder(t, rec)
		if len(gotNames) != len(tc.want) {
			t.Fatalf("%s：expected %d tasks, got %v", tc.direction, len(tc.want), gotNames)
		}
		for i, want := range tc.want {
			if gotNames[i] != want {
				t.Fatalf("%s：expected order %v, got %v", tc.direction, tc.want, gotNames)
			}
		}
	}
}

// 「下次运行」列排序：升序时时间由早到晚，且禁用任务与手动任务（都算不出下次运行）恒排最后。
// 刻意不写死两条 cron 任务的先后：next_run_at 是响应期现算的，
// 写死具体名字会在「两条 cron 恰好命中同一个时间点」的时刻翻车，
// 所以断言改成「有值的都在前面且非递减、没值的都在后面」——这正是契约本身。
func TestTaskListSortsByNextRunAtWithNoScheduleLast(t *testing.T) {
	testutil.SetupTestEnv(t)

	engine := newProtectedRouter()
	user := testutil.MustCreateUser(t, "task-next-run-operator", "operator")
	accessToken := testutil.MustCreateAccessToken(t, user.Username, user.Role)

	tasks := []*model.Task{
		{Name: "cron-minutely", Command: "task a.py", CronExpression: "* * * * *", TaskType: model.TaskTypeCron, Status: model.TaskStatusEnabled},
		{Name: "cron-daily", Command: "task b.py", CronExpression: "0 3 * * *", TaskType: model.TaskTypeCron, Status: model.TaskStatusEnabled},
		{Name: "disabled-cron", Command: "task c.py", CronExpression: "0 0 * * *", TaskType: model.TaskTypeCron, Status: model.TaskStatusDisabled},
		{Name: "manual-task", Command: "task d.py", CronExpression: "", TaskType: model.TaskTypeManual, Status: model.TaskStatusEnabled},
	}
	for _, task := range tasks {
		if err := database.DB.Create(task).Error; err != nil {
			t.Fatalf("create task %q: %v", task.Name, err)
		}
	}

	noSchedule := map[string]bool{"disabled-cron": true, "manual-task": true}

	for _, direction := range []string{"asc", "desc"} {
		sortJSON := fmt.Sprintf(`[{"field":"next_run_at","direction":"%s"}]`, direction)
		rec := performRequest(engine, http.MethodGet, "/api/v1/tasks?sort_rules="+url.QueryEscape(sortJSON), map[string]string{
			"Authorization": "Bearer " + accessToken,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s：expected status 200, got %d: %s", direction, rec.Code, rec.Body.String())
		}

		gotNames := taskListNamesInOrder(t, rec)
		gotTimes := taskListNextRunTimesInOrder(t, rec)
		if len(gotNames) != 4 || len(gotTimes) != 4 {
			t.Fatalf("%s：expected 4 tasks, got %v", direction, gotNames)
		}

		// 前两条必须是算得出下次运行的 cron 任务。
		for i := 0; i < 2; i++ {
			if gotTimes[i] == nil {
				t.Fatalf("%s：前两条应当有 next_run_at，实际顺序 %v", direction, gotNames)
			}
			if noSchedule[gotNames[i]] {
				t.Fatalf("%s：算不出下次运行的任务不该排在前面，实际顺序 %v", direction, gotNames)
			}
		}
		// 后两条必须是禁用任务与手动任务，且 asc / desc 都一样 —— 空值不跟随方向翻转。
		for i := 2; i < 4; i++ {
			if gotTimes[i] != nil {
				t.Fatalf("%s：后两条不该有 next_run_at，实际顺序 %v", direction, gotNames)
			}
			if !noSchedule[gotNames[i]] {
				t.Fatalf("%s：期望禁用任务与手动任务排在最后，实际顺序 %v", direction, gotNames)
			}
		}

		if direction == "asc" && gotTimes[1].Before(*gotTimes[0]) {
			t.Fatalf("asc：next_run_at 应当由早到晚，got %v / %v", gotTimes[0], gotTimes[1])
		}
		if direction == "desc" && gotTimes[1].After(*gotTimes[0]) {
			t.Fatalf("desc：next_run_at 应当由晚到早，got %v / %v", gotTimes[0], gotTimes[1])
		}
	}
}
