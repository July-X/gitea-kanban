// v0.7.22：review event state 字段从 body 关键词推断（Gitea 1.26+ timeline 端
// review event `state` 字段恒为 null，reviews 端点 500 / 返空数组，无法直接拿）
package gitea

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestGiteaAdapter_ReviewStateInference 验证 review event state 字段推断
// （Gitea 1.26+ timeline 端 review event state=null，关键词推断 fallback）
func TestGiteaAdapter_ReviewStateInference(t *testing.T) {
	cases := []struct {
		name        string
		reviewBody  string
		wantState   string
		description string
	}{
		{
			name:        "approve 中文+英文",
			reviewBody:  "测试 approve",
			wantState:   "approved",
			description: "body 含 'approve' 关键词 → approved",
		},
		{
			name:        "approved 标准",
			reviewBody:  "LGTM, approved!",
			wantState:   "approved",
			description: "body 含 'approved' 关键词 → approved",
		},
		{
			name:        "lgtm 简写",
			reviewBody:  "lgtm",
			wantState:   "approved",
			description: "body 含 'lgtm' 关键词 → approved",
		},
		{
			name:        "request changes",
			reviewBody:  "please request changes here",
			wantState:   "changes_requested",
			description: "body 含 'request changes' 关键词 → changes_requested",
		},
		{
			name:        "blocking",
			reviewBody:  "blocking issue",
			wantState:   "changes_requested",
			description: "body 含 'blocking' 关键词 → changes_requested",
		},
		{
			name:        "comment 默认",
			reviewBody:  "评审+1",
			wantState:   "commented",
			description: "body 不含关键词 → commented（默认）",
		},
		{
			name:        "looks good",
			reviewBody:  "looks good to me",
			wantState:   "approved",
			description: "body 含 'looks good' 关键词 → approved",
		},
		{
			name:        "needs changes",
			reviewBody:  "needs changes in this file",
			wantState:   "changes_requested",
			description: "body 含 'needs changes' 关键词 → changes_requested",
		},
		{
			name:        "空 body",
			reviewBody:  "",
			wantState:   "commented",
			description: "空 body → commented（默认）",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 用临时 httptest server 返 1 个 review event
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode([]map[string]interface{}{
					{
						"id":         100,
						"type":       "review",
						"body":       tc.reviewBody,
						"user":       map[string]string{"login": "alice"},
						"created_at": "2024-06-04T10:00:00Z",
					},
				})
			}))
			defer server.Close()

			adapter := NewGiteaAdapter()
			items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
			if err != nil {
				t.Fatalf("ListPullTimeline failed: %v", err)
			}
			if len(items) != 1 {
				t.Fatalf("len(items) = %d, want 1", len(items))
			}
			if items[0].State != tc.wantState {
				t.Errorf("body=%q: items[0].State = %q, want %q (%s)", tc.reviewBody, items[0].State, tc.wantState, tc.description)
			}
		})
	}
}
