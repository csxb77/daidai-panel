package handler_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"daidai-panel/database"
	"daidai-panel/model"
	"daidai-panel/testutil"
)

func TestSubscriptionCreatePersistsForceOverwriteFalse(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-operator", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	body := `{"name":"demo-sub","type":"git-repo","url":"https://github.com/example/demo.git","force_overwrite":false}`
	rec := performJSONRequest(engine, http.MethodPost, "/api/v1/subscriptions", body, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d, body=%s", rec.Code, rec.Body.String())
	}

	payload := decodeJSONMap(t, rec)
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected data map, got %T", payload["data"])
	}
	if got, _ := data["force_overwrite"].(bool); got {
		t.Fatalf("expected response force_overwrite false, got %v", data["force_overwrite"])
	}

	var sub model.Subscription
	if err := database.DB.Where("name = ?", "demo-sub").First(&sub).Error; err != nil {
		t.Fatalf("query subscription: %v", err)
	}
	if sub.ForceOverwrite == nil || *sub.ForceOverwrite {
		t.Fatalf("expected force_overwrite persisted false, got %#v", sub.ForceOverwrite)
	}
}

func TestSubscriptionUpdateKeepsForceOverwriteFalseAfterReload(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-editor", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	forceOverwrite := true
	sub := model.Subscription{
		Name:           "editable-sub",
		Type:           model.SubTypeGitRepo,
		URL:            "https://github.com/example/editable.git",
		Enabled:        true,
		ForceOverwrite: &forceOverwrite,
	}
	if err := database.DB.Create(&sub).Error; err != nil {
		t.Fatalf("create subscription: %v", err)
	}

	updateBody := `{"force_overwrite":false,"alias":"edited-sub"}`
	updateRec := performJSONRequest(engine, http.MethodPut, "/api/v1/subscriptions/"+strconv.FormatUint(uint64(sub.ID), 10), updateBody, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body=%s", updateRec.Code, updateRec.Body.String())
	}

	var updated model.Subscription
	if err := database.DB.First(&updated, sub.ID).Error; err != nil {
		t.Fatalf("reload subscription: %v", err)
	}
	if updated.ForceOverwrite == nil || *updated.ForceOverwrite {
		t.Fatalf("expected force_overwrite updated false, got %#v", updated.ForceOverwrite)
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/subscriptions?keyword=editable-sub", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list 200, got %d, body=%s", listRec.Code, listRec.Body.String())
	}

	listPayload := decodeJSONMap(t, listRec)
	items, ok := listPayload["data"].([]interface{})
	if !ok || len(items) == 0 {
		t.Fatalf("expected subscription list, got %T", listPayload["data"])
	}
	item, ok := items[0].(map[string]interface{})
	if !ok {
		t.Fatalf("expected list item map, got %T", items[0])
	}
	if got, _ := item["force_overwrite"].(bool); got {
		t.Fatalf("expected list force_overwrite false after reload, got %v", item["force_overwrite"])
	}
}

// TestSubscriptionCreatePersistsOverwriteMode 守住「设了能存住」：
// v2.2.15 删的正是这条链路（后端字段还在、前端和 handler 没了），漏一处就是设完刷新又回到跟随全局。
func TestSubscriptionCreatePersistsOverwriteMode(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-overwrite-operator", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	body := `{"name":"overwrite-sub","type":"git-repo","url":"https://github.com/example/overwrite.git","overwrite_mode":"preserve"}`
	rec := performJSONRequest(engine, http.MethodPost, "/api/v1/subscriptions", body, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d, body=%s", rec.Code, rec.Body.String())
	}

	payload := decodeJSONMap(t, rec)
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected data map, got %T", payload["data"])
	}
	if got, _ := data["overwrite_mode"].(string); got != model.SubOverwritePreserve {
		t.Fatalf("expected response overwrite_mode=%q, got %#v", model.SubOverwritePreserve, data["overwrite_mode"])
	}

	var sub model.Subscription
	if err := database.DB.Where("name = ?", "overwrite-sub").First(&sub).Error; err != nil {
		t.Fatalf("query subscription: %v", err)
	}
	if sub.OverwriteMode != model.SubOverwritePreserve {
		t.Fatalf("expected overwrite_mode persisted %q, got %q", model.SubOverwritePreserve, sub.OverwriteMode)
	}
}

// TestSubscriptionCreateNormalizesDirtyOverwriteMode 守住脏值归一：
// 不传 / 传非法值都必须落成 inherit（跟随全局），不能让脏字符串进库把判定搞成未定义行为。
func TestSubscriptionCreateNormalizesDirtyOverwriteMode(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-overwrite-dirty", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	cases := []struct {
		name string
		body string
	}{
		{"dirty-mode-sub", `{"name":"dirty-mode-sub","type":"git-repo","url":"https://github.com/example/a.git","overwrite_mode":"not-a-mode"}`},
		{"missing-mode-sub", `{"name":"missing-mode-sub","type":"git-repo","url":"https://github.com/example/b.git"}`},
	}

	for _, tc := range cases {
		rec := performJSONRequest(engine, http.MethodPost, "/api/v1/subscriptions", tc.body, map[string]string{
			"Authorization": "Bearer " + token,
		}, "")
		if rec.Code != http.StatusCreated {
			t.Fatalf("[%s] expected 201, got %d, body=%s", tc.name, rec.Code, rec.Body.String())
		}

		var sub model.Subscription
		if err := database.DB.Where("name = ?", tc.name).First(&sub).Error; err != nil {
			t.Fatalf("[%s] query subscription: %v", tc.name, err)
		}
		if sub.OverwriteMode != model.SubOverwriteInherit {
			t.Fatalf("[%s] expected overwrite_mode normalized to %q, got %q", tc.name, model.SubOverwriteInherit, sub.OverwriteMode)
		}
	}
}

// TestSubscriptionUpdateNormalizesOverwriteMode 覆盖编辑链路：
// 合法值要存住，脏值要归一回 inherit，且列表接口读出来的也是归一后的值。
func TestSubscriptionUpdateNormalizesOverwriteMode(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-overwrite-editor", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	sub := model.Subscription{
		Name:          "overwrite-editable-sub",
		Type:          model.SubTypeGitRepo,
		URL:           "https://github.com/example/overwrite-editable.git",
		Enabled:       true,
		OverwriteMode: model.SubOverwriteInherit,
	}
	if err := database.DB.Create(&sub).Error; err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	subPath := "/api/v1/subscriptions/" + strconv.FormatUint(uint64(sub.ID), 10)

	updateRec := performJSONRequest(engine, http.MethodPut, subPath, `{"overwrite_mode":"force"}`, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body=%s", updateRec.Code, updateRec.Body.String())
	}

	var updated model.Subscription
	if err := database.DB.First(&updated, sub.ID).Error; err != nil {
		t.Fatalf("reload subscription: %v", err)
	}
	if updated.OverwriteMode != model.SubOverwriteForce {
		t.Fatalf("expected overwrite_mode updated to %q, got %q", model.SubOverwriteForce, updated.OverwriteMode)
	}

	dirtyRec := performJSONRequest(engine, http.MethodPut, subPath, `{"overwrite_mode":"whatever"}`, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if dirtyRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for dirty value, got %d, body=%s", dirtyRec.Code, dirtyRec.Body.String())
	}
	if err := database.DB.First(&updated, sub.ID).Error; err != nil {
		t.Fatalf("reload subscription after dirty update: %v", err)
	}
	if updated.OverwriteMode != model.SubOverwriteInherit {
		t.Fatalf("expected dirty overwrite_mode normalized to %q, got %q", model.SubOverwriteInherit, updated.OverwriteMode)
	}

	listRec := performRequest(engine, http.MethodGet, "/api/v1/subscriptions?keyword=overwrite-editable-sub", map[string]string{
		"Authorization": "Bearer " + token,
	})
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list 200, got %d, body=%s", listRec.Code, listRec.Body.String())
	}
	listPayload := decodeJSONMap(t, listRec)
	items, ok := listPayload["data"].([]interface{})
	if !ok || len(items) == 0 {
		t.Fatalf("expected subscription list, got %T", listPayload["data"])
	}
	item, ok := items[0].(map[string]interface{})
	if !ok {
		t.Fatalf("expected list item map, got %T", items[0])
	}
	if got, _ := item["overwrite_mode"].(string); got != model.SubOverwriteInherit {
		t.Fatalf("expected list overwrite_mode %q, got %#v", model.SubOverwriteInherit, item["overwrite_mode"])
	}
}

func TestSubscriptionCreatePersistsTokenAuthWithoutLeakingToken(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-token-operator", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	body := `{"name":"token-sub","type":"git-repo","url":"https://github.com/example/private.git","auth_type":"token","auth_token":"ghp_demo_token"}`
	rec := performJSONRequest(engine, http.MethodPost, "/api/v1/subscriptions", body, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d, body=%s", rec.Code, rec.Body.String())
	}

	payload := decodeJSONMap(t, rec)
	data, ok := payload["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected data map, got %T", payload["data"])
	}
	if got, _ := data["auth_type"].(string); got != model.SubAuthTypeToken {
		t.Fatalf("expected auth_type=%q, got %#v", model.SubAuthTypeToken, data["auth_type"])
	}
	if got, _ := data["has_auth_token"].(bool); !got {
		t.Fatalf("expected has_auth_token=true, got %#v", data["has_auth_token"])
	}
	if _, exists := data["auth_token"]; exists {
		t.Fatalf("did not expect auth_token in response payload: %#v", data)
	}

	var sub model.Subscription
	if err := database.DB.Where("name = ?", "token-sub").First(&sub).Error; err != nil {
		t.Fatalf("query subscription: %v", err)
	}
	if sub.EffectiveAuthType() != model.SubAuthTypeToken {
		t.Fatalf("expected stored auth type token, got %q", sub.EffectiveAuthType())
	}
	if strings.TrimSpace(sub.AuthToken) != "ghp_demo_token" {
		t.Fatalf("expected stored auth token, got %q", sub.AuthToken)
	}
	if sub.SSHKeyID != nil {
		t.Fatalf("expected ssh_key_id cleared for token auth, got %#v", sub.SSHKeyID)
	}
}

func TestSubscriptionUpdateKeepsExistingTokenWhenAuthTokenOmitted(t *testing.T) {
	testutil.SetupTestEnv(t)

	operator := testutil.MustCreateUser(t, "subscription-token-editor", "operator")
	token := testutil.MustCreateAccessToken(t, operator.Username, operator.Role)
	engine := newProtectedRouter()

	sub := model.Subscription{
		Name:      "editable-token-sub",
		Type:      model.SubTypeGitRepo,
		URL:       "https://github.com/example/private.git",
		Enabled:   true,
		AuthType:  model.SubAuthTypeToken,
		AuthToken: "ghp_keep_me",
	}
	if err := database.DB.Create(&sub).Error; err != nil {
		t.Fatalf("create subscription: %v", err)
	}

	updateBody := `{"auth_type":"token","auth_token":"","alias":"token-edited"}`
	updateRec := performJSONRequest(engine, http.MethodPut, "/api/v1/subscriptions/"+strconv.FormatUint(uint64(sub.ID), 10), updateBody, map[string]string{
		"Authorization": "Bearer " + token,
	}, "")
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body=%s", updateRec.Code, updateRec.Body.String())
	}

	var updated model.Subscription
	if err := database.DB.First(&updated, sub.ID).Error; err != nil {
		t.Fatalf("reload subscription: %v", err)
	}
	if strings.TrimSpace(updated.AuthToken) != "ghp_keep_me" {
		t.Fatalf("expected auth token to stay unchanged, got %q", updated.AuthToken)
	}
	if updated.EffectiveAuthType() != model.SubAuthTypeToken {
		t.Fatalf("expected auth type token after update, got %q", updated.EffectiveAuthType())
	}
}
