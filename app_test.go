package main

import (
	"testing"
)

func TestEpochMsToISO(t *testing.T) {
	tests := []struct {
		name string
		ms   int64
		want string
	}{
		{"zero", 0, ""},
		{"negative", -1, ""},
		// 1719000000000 ms = 2024-06-21 20:00:00 UTC
		{"valid", 1719000000000, "2024-06-21T20:00:00Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := epochMsToISO(tt.ms); got != tt.want {
				t.Errorf("epochMsToISO(%d) = %q, want %q", tt.ms, got, tt.want)
			}
		})
	}
}

func TestClassifyKeychainError(t *testing.T) {
	tests := []struct {
		name     string
		errMsg   string
		wantCode string
	}{
		{"keyring missing", "keyring not available", "keychain_unavailable"},
		{"dbus missing", "dbus connection failed", "keychain_unavailable"},
		{"Secret Service", "Secret Service not running", "keychain_unavailable"},
		{"not supported", "keyring not supported on this platform", "keychain_unavailable"},
		{"access denied", "access denied by user", "keychain_access_denied"},
		{"permission denied", "permission denied", "keychain_access_denied"},
		{"user cancelled", "User cancelled keychain access", "keychain_access_denied"},
		{"generic", "some other error", "internal"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classifyKeychainError(errString(tt.errMsg))
			if err.Code != tt.wantCode {
				t.Errorf("classifyKeychainError(%q).Code = %q, want %q", tt.errMsg, err.Code, tt.wantCode)
			}
		})
	}
}

// errString 是一个简单的 error 实现（用于测试错误分类）
type errString string

func (e errString) Error() string { return string(e) }
