package git

import (
	"sync"
	"testing"
)

// TestParseProgress_SidebandSamples 验证典型 sideband 行能被正确解析
func TestParseProgress_SidebandSamples(t *testing.T) {
	cases := []struct {
		name        string
		input       string
		wantStage   SyncStage
		wantPercent int
		wantCur     int
		wantTotal   int
	}{
		{
			name:        "Counting 12%",
			input:       "Counting objects: 12% (123/1000)\r",
			wantStage:   StageCounting,
			wantPercent: 12,
			wantCur:     123,
			wantTotal:   1000,
		},
		{
			name:        "Receiving 45% 带 speed",
			input:       "Receiving objects: 45% (1234/5678), 1.23 MiB | 5.67 MiB/s\r",
			wantStage:   StageReceiving,
			wantPercent: 45,
			wantCur:     1234,
			wantTotal:   5678,
		},
		{
			name:        "Receiving 100%",
			input:       "Receiving objects: 100% (5678/5678), 5.43 MiB | 4.12 MiB/s\r",
			wantStage:   StageReceiving,
			wantPercent: 100,
			wantCur:     5678,
			wantTotal:   5678,
		},
		{
			name:        "Resolving 100%",
			input:       "Resolving deltas: 100% (50/50)\r",
			wantStage:   StageResolvingDeltas,
			wantPercent: 100,
			wantCur:     50,
			wantTotal:   50,
		},
		{
			name:        "Checking out 100%",
			input:       "Checking out files: 100% (10/10)\r",
			wantStage:   StageCheckingOut,
			wantPercent: 100,
			wantCur:     10,
			wantTotal:   10,
		},
		{
			name:        "Updating 50%",
			input:       "Updating files: 50% (5/10)\r",
			wantStage:   StageUpdating,
			wantPercent: 50,
			wantCur:     5,
			wantTotal:   10,
		},
		{
			name:        "Compressing",
			input:       "Compressing objects: 80% (40/50)\r",
			wantStage:   StageCompressing,
			wantPercent: 80,
			wantCur:     40,
			wantTotal:   50,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got SyncProgress
			var called bool
			ParseProgress(c.input, func(p SyncProgress) {
				got = p
				called = true
			})
			if !called {
				t.Fatal("callback was not called")
			}
			if got.Stage != c.wantStage {
				t.Errorf("Stage = %q, want %q", got.Stage, c.wantStage)
			}
			if got.Percent != c.wantPercent {
				t.Errorf("Percent = %d, want %d", got.Percent, c.wantPercent)
			}
			if got.Cur != c.wantCur {
				t.Errorf("Cur = %d, want %d", got.Cur, c.wantCur)
			}
			if got.Total != c.wantTotal {
				t.Errorf("Total = %d, want %d", got.Total, c.wantTotal)
			}
		})
	}
}

// TestParseProgress_NoPercentYet 验证"还没出百分比"时的 fallback
func TestParseProgress_NoPercentYet(t *testing.T) {
	var got SyncProgress
	ParseProgress("Counting objects: \r", func(p SyncProgress) {
		got = p
	})
	if got.Stage != StageCounting {
		t.Errorf("Stage = %q, want counting", got.Stage)
	}
	if got.Percent != -1 {
		t.Errorf("Percent = %d, want -1 (unknown)", got.Percent)
	}
	if got.Message == "" {
		t.Error("Message should be preserved")
	}
}

// TestParseProgress_UnknownStage 验证无法识别 stage 的 fallback（透传原文）
func TestParseProgress_UnknownStage(t *testing.T) {
	var got SyncProgress
	ParseProgress("Total 1234 (delta 0), reused 0 (delta 0)\r", func(p SyncProgress) {
		got = p
	})
	if got.Stage != StageUnknown {
		t.Errorf("Stage = %q, want unknown", got.Stage)
	}
	if got.Percent != -1 {
		t.Errorf("Percent = %d, want -1", got.Percent)
	}
	if got.Message == "" {
		t.Error("Message should preserve raw text")
	}
}

// TestParseProgress_NilCallback 不 panic
func TestParseProgress_NilCallback(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil callback should not panic: %v", r)
		}
	}()
	ParseProgress("Receiving objects: 50% (5/10)\r", nil)
}

// TestParseProgress_EmptyLine 跳过空行
func TestParseProgress_EmptyLine(t *testing.T) {
	called := false
	ParseProgress("\r\n", func(p SyncProgress) {
		called = true
	})
	if called {
		t.Error("empty line should not invoke callback")
	}
}

// TestParseProgress_PercentOver100 钳到 100
func TestParseProgress_PercentOver100(t *testing.T) {
	var got SyncProgress
	ParseProgress("Receiving objects: 150% (15/10)\r", func(p SyncProgress) {
		got = p
	})
	if got.Percent != 100 {
		t.Errorf("Percent = %d, want 100 (clamped)", got.Percent)
	}
}

// TestSafeWrap 验证 panic 隔离
func TestSafeWrap(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("SafeWrap should swallow panic: %v", r)
		}
	}()
	bad := SafeWrap(func(p SyncProgress) {
		panic("boom")
	})
	bad(SyncProgress{Stage: StageReceiving, Percent: 50})
}

// TestSafeWrap_NilReturnsNil
func TestSafeWrap_Nil(t *testing.T) {
	if SafeWrap(nil) != nil {
		t.Error("SafeWrap(nil) should return nil")
	}
}

// TestEmitProgress 完成阶段手动触发
func TestEmitProgress_DoneStage(t *testing.T) {
	var got SyncProgress
	cb := func(p SyncProgress) { got = p }
	gitEmitProgress(cb, StageDone, 100, "synchronized")
	if got.Stage != StageDone || got.Percent != 100 {
		t.Errorf("got stage=%q percent=%d", got.Stage, got.Percent)
	}
}

// TestEmitProgress_NilSafe
func TestEmitProgress_NilSafe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("nil callback should not panic: %v", r)
		}
	}()
	gitEmitProgress(nil, StageDone, 100, "")
}

// TestSidebandWriter_Integration 验证 SidebandWriter 的 io.Writer 接口
func TestSidebandWriter_Integration(t *testing.T) {
	var (
		mu     sync.Mutex
		events []SyncProgress
	)
	cb := func(p SyncProgress) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, p)
	}
	w := NewSidebandWriter(cb)
	_, _ = w.Write([]byte("Counting objects: 12% (123/1000)\r"))
	_, _ = w.Write([]byte("Receiving objects: 45% (450/1000), 1.00 MiB\r"))

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].Stage != StageCounting {
		t.Errorf("events[0].Stage = %q, want counting", events[0].Stage)
	}
	if events[1].Percent != 45 {
		t.Errorf("events[1].Percent = %d, want 45", events[1].Percent)
	}
}

// 私有别名，避免和 EmitProgress 同名冲突（EmitProgress 是公开 API）
var gitEmitProgress = EmitProgress
