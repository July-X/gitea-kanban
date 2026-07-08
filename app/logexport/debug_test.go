package logexport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDebug_RedactViaJSON(t *testing.T) {
	raw := []byte(`{"accounts":[{"id":"a1","username":"alice","token":"PAT-SECRET"}]}`)
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	redactAny(v)
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("redacted JSON:\n%s", string(out))
	if !strings.Contains(string(out), "<REDACTED>") {
		t.Error("should contain <REDACTED>")
	}
}

func TestDebug_ZipStateContent(t *testing.T) {
	dir := t.TempDir()
	desktop := filepath.Join(dir, "Desktop")
	logDir := filepath.Join(dir, "logs", "main")
	os.MkdirAll(logDir, 0o755)
	setupLogFiles(t, logDir, []string{"main-2026-07-01.log"})

	statePath := filepath.Join(dir, "state.json")
	os.WriteFile(statePath, []byte(`{"accounts":[{"id":"a1","username":"alice","token":"PAT-SECRET"}]}`), 0o644)

	summary, err := Export(ExportOptions{
		DesktopPath: desktop,
		LogDir:      logDir,
		StatePath:   statePath,
		Version:     "0.6.0",
		Platform:    "darwin",
		DataDir:     dir,
		MaxLogs:     5,
	})
	if err != nil {
		t.Fatal(err)
	}

	r, err := zipOpenReader(t, summary.ZipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	for _, f := range r.File {
		t.Logf("zip entry: %s (size=%d)", f.Name, f.UncompressedSize64)
		if f.Name == "state.json" {
			rc, _ := f.Open()
			data := readAll(t, rc)
			rc.Close()
			t.Logf("state.json content:\n%s", string(data))
		}
		if f.Name == "state.json.corrupt" {
			t.Error("state.json.corrupt found — json.Unmarshal failed!")
		}
	}
}
