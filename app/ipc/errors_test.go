package ipc

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestIpcError_Error(t *testing.T) {
	tests := []struct {
		name string
		err  *IpcError
		want string
	}{
		{
			name: "无 hint",
			err:  &IpcError{Code: CodeInternal, Message: "应用出错了"},
			want: "应用出错了",
		},
		{
			name: "有 hint",
			err:  &IpcError{Code: CodeTokenInvalid, Message: "登录已过期", Hint: "请重新生成 token"},
			want: "登录已过期（请重新生成 token）",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.Error(); got != tt.want {
				t.Errorf("Error() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFormatError_IpcError(t *testing.T) {
	ipcErr := &IpcError{
		Code:       CodeTokenInvalid,
		Message:    "登录已过期或 token 无效",
		Hint:       "请到 Gitea 重新生成 token 后再连接",
		Cause:      "401 Unauthorized",
		HTTPStatus: 401,
	}
	got := FormatError(ipcErr)
	// 应当返回结构体本身（Wails 会 JSON 化它）
	if got != ipcErr {
		t.Errorf("FormatError(IpcError) should return the IpcError struct, got %T", got)
	}
}

func TestFormatError_PlainError(t *testing.T) {
	plain := errors.New("plain string error")
	got := FormatError(plain)
	// 应当返回字符串（前端走 normalizeError 的 internal 兜底）
	str, ok := got.(string)
	if !ok {
		t.Fatalf("FormatError(plain) should return string, got %T", got)
	}
	if str != "plain string error" {
		t.Errorf("FormatError(plain) = %q, want %q", str, "plain string error")
	}
}

func TestFormatError_WrappedIpcError(t *testing.T) {
	// fmt.Errorf("...: %w", ipcErr) 应当被 errors.As 识别为 IpcError
	ipcErr := &IpcError{Code: CodeNotFound, Message: "找不到该资源"}
	wrapped := fmt.Errorf("outer context: %w", ipcErr)

	got := FormatError(wrapped)
	if got != ipcErr {
		t.Errorf("FormatError(wrapped IpcError) should unwrap to IpcError, got %T", got)
	}
}

func TestFromHTTPStatus(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		wantCode   string
		wantStatus int
	}{
		{"401", 401, CodeTokenInvalid, 401},
		{"403", 403, CodePermissionDenied, 403},
		{"404", 404, CodeNotFound, 404},
		{"409", 409, CodeConflict, 409},
		{"422", 422, CodeValidationFailed, 422},
		{"429", 429, CodeRateLimited, 429},
		{"502", 502, CodeNetworkOffline, 502},
		{"503", 503, CodeNetworkOffline, 503},
		{"504", 504, CodeNetworkOffline, 504},
		{"500", 500, CodeGiteaError, 500},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := FromHTTPStatus(tt.status, "body content")
			if err.Code != tt.wantCode {
				t.Errorf("FromHTTPStatus(%d).Code = %q, want %q", tt.status, err.Code, tt.wantCode)
			}
			if err.HTTPStatus != tt.wantStatus {
				t.Errorf("FromHTTPStatus(%d).HTTPStatus = %d, want %d", tt.status, err.HTTPStatus, tt.wantStatus)
			}
			if err.Message == "" {
				t.Error("Message should be non-empty")
			}
		})
	}
}

func TestNewKeychainUnavailable_HasHint(t *testing.T) {
	err := NewKeychainUnavailable("dbus not available")
	if err.Code != CodeKeychainUnavailable {
		t.Errorf("Code = %q, want %q", err.Code, CodeKeychainUnavailable)
	}
	if !strings.Contains(err.Hint, "gnome-keyring") && !strings.Contains(err.Hint, "kwallet") {
		t.Errorf("Hint should mention gnome-keyring or kwallet, got %q", err.Hint)
	}
	if !strings.Contains(err.Cause, "dbus") {
		t.Errorf("Cause should contain original message, got %q", err.Cause)
	}
}

func TestTruncateCause(t *testing.T) {
	short := "ok"
	if got := TruncateCause(short); got != short {
		t.Errorf("TruncateCause(short) = %q, want %q", got, short)
	}

	long := strings.Repeat("a", 250)
	got := TruncateCause(long)
	if len(got) > 210 {
		t.Errorf("TruncateCause should truncate to <= 210 chars, got %d", len(got))
	}
	if !strings.HasSuffix(got, "...") {
		t.Error("Truncated result should end with '...'")
	}

	// 边界：trim 后 200 字符
	spaced := "  " + strings.Repeat("x", 200) + "  "
	got = TruncateCause(spaced)
	if strings.Contains(got, "  ") {
		t.Error("TruncateCause should trim leading/trailing whitespace")
	}
}

func TestNewUnauthenticated_KeepsCause(t *testing.T) {
	err := NewUnauthenticated("token expired at 2026-06-22")
	if err.Code != CodeUnauthenticated {
		t.Errorf("Code = %q, want %q", err.Code, CodeUnauthenticated)
	}
	if err.Cause != "token expired at 2026-06-22" {
		t.Errorf("Cause should be preserved, got %q", err.Cause)
	}
	if err.Hint == "" {
		t.Error("Hint should be non-empty")
	}
}
