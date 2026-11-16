package plugin

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestSchedulerPickEligibleGlobalError(t *testing.T) {
	for _, group := range []string{"", "team"} {
		t.Run("group="+group, func(t *testing.T) {
			app, plain := configureTestApp(t)
			t.Cleanup(app.Shutdown)
			request := SchedulerPickRequest{
				Provider: "codex",
				Model:    "gpt-5-codex",
				Options: SchedulerPickOptions{
					Headers:  map[string][]string{"Authorization": {"Bearer " + plain}},
					Metadata: map[string]any{"group": group},
				},
				Candidates: []SchedulerAuthCandidate{
					{ID: "recovered", Provider: "codex", Status: "active", Attributes: map[string]string{"plan_type": "team"}},
				},
			}
			if got := schedulerPickForTest(t, app, request); got.AuthID != "recovered" {
				t.Fatalf("initial pick = %q, want recovered", got.AuthID)
			}
			// CPA can resubmit the same credential with global error after a model
			// cooldown expires or while another model remains eligible.
			for _, status := range []string{"error", " ERROR "} {
				request.Candidates[0].Status = status
				if got := schedulerPickForTest(t, app, request); got.AuthID != "recovered" {
					t.Fatalf("eligible status %q pick = %q, want recovered", status, got.AuthID)
				}
			}
		})
	}
}

func TestSchedulerPickGlobalErrorPreservesPolicy(t *testing.T) {
	app, _ := configureTestApp(t)
	t.Cleanup(app.Shutdown)
	request := SchedulerPickRequest{
		Provider: "codex",
		Model:    "gpt-5-codex",
		Options:  SchedulerPickOptions{Metadata: map[string]any{"group": "team"}},
		Candidates: []SchedulerAuthCandidate{
			{ID: "wrong-group", Provider: "codex", Status: "error", Priority: 100, Weight: 100, Attributes: map[string]string{"plan_type": "plus"}},
			{ID: "paused", Provider: "codex", Status: "error", Priority: 100, Weight: 0, Attributes: map[string]string{"plan_type": "team"}},
			{ID: "negative", Provider: "codex", Status: "error", Priority: 100, Weight: -1, Attributes: map[string]string{"plan_type": "team"}},
			{ID: "heavy", Provider: "codex", Status: "error", Priority: 10, Weight: 2, Attributes: map[string]string{"plan_type": "team"}},
			{ID: "light", Provider: "codex", Status: "active", Priority: 10, Weight: 1, Attributes: map[string]string{"plan_type": "team"}},
			{ID: "fallback", Provider: "codex", Status: "error", Priority: 1, Weight: 100, Attributes: map[string]string{"plan_type": "team"}},
		},
	}
	counts := map[string]int{}
	for i := 0; i < 9; i++ {
		counts[schedulerPickForTest(t, app, request).AuthID]++
	}
	if len(counts) != 2 || counts["heavy"] != 6 || counts["light"] != 3 {
		t.Fatalf("expected only highest-priority positive-weight team candidates at 2:1, got %v", counts)
	}
	request.Candidates = request.Candidates[:3]
	assertSchedulerStatusError(t, app, request)
	request.Candidates = request.Candidates[:1]
	assertSchedulerStatusError(t, app, request)
}

func TestSchedulerPickBlockingStatusesRemainExcluded(t *testing.T) {
	for _, status := range []string{
		"disabled", "expired", "revoked", "invalid", "unavailable", "cooldown",
		"cooling_down", "quota_exhausted", "exhausted", "blocked",
		" DISABLED ", "Cooling-Down", "quota exhausted",
	} {
		t.Run(status, func(t *testing.T) {
			app, _ := configureTestApp(t)
			t.Cleanup(app.Shutdown)
			request := SchedulerPickRequest{
				Provider: "codex",
				Options:  SchedulerPickOptions{Metadata: map[string]any{"group": "team"}},
				Candidates: []SchedulerAuthCandidate{
					{ID: "blocked", Provider: "codex", Status: status, Priority: 100, Weight: 100, Attributes: map[string]string{"plan_type": "team"}},
					{ID: "eligible", Provider: "codex", Status: "error", Weight: 1, Attributes: map[string]string{"plan_type": "team"}},
				},
			}
			if got := schedulerPickForTest(t, app, request); got.AuthID != "eligible" {
				t.Fatalf("status %q should be excluded, picked %q", status, got.AuthID)
			}
			request.Candidates = request.Candidates[:1]
			assertSchedulerStatusError(t, app, request)
		})
	}
}

func assertSchedulerStatusError(t *testing.T, app *App, request SchedulerPickRequest) {
	t.Helper()
	rawRequest, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	rawResponse, err := app.HandleMethod(MethodSchedulerPick, rawRequest)
	if err != nil {
		t.Fatal(err)
	}
	var envelope Envelope
	if err := json.Unmarshal(rawResponse, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.OK || envelope.Error == nil || envelope.Error.Code != "auth_not_found" || envelope.Error.HTTPStatus != http.StatusServiceUnavailable {
		t.Fatalf("expected auth_not_found without fallback, got %+v", envelope)
	}
}
