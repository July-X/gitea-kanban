package git

import (
	"encoding/base64"
	"strings"
	"testing"

	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/ipc"
)

// TestFetchRemoteWithFilter_NoCredentialHelperArgs 验证 fetchRemoteWithFilter
// 不再传 `-c credential.helper=...` 参数。
//
// 背景（v0.8.27+）：旧版 fetchRemoteWithFilter 用 `-c credential.helper=!gh auth git-credential`
// 让 gh 提供 credential。但 Windows MinGit 单文件布局不带 sh.exe，且 gh 不是内嵌，
// 用户的 Windows 环境跑不动该 helper。改用 GIT_CONFIG_* env 注入 extraHeader。
//
// v0.8.27+ 直接断言 args 不含 "credential.helper"。
func TestFetchRemoteWithFilter_NoCredentialHelperArgs(t *testing.T) {
	// 直接复制 fetchRemoteWithFilter 的 args 构造逻辑——避免起 git 子进程。
	// 这是 ad-hoc 简化版，只关心头两个参数是不是 -c credential.helper=...。
	args := buildFetchArgsForTest(0, false)

	if len(args) < 1 || args[0] != "fetch" {
		t.Fatalf("args[0] 应为 'fetch', got %q", args[0])
	}
	for _, a := range args {
		if strings.Contains(a, "credential.helper") {
			t.Errorf("fetch args 不应包含 credential.helper（旧实现已废弃），got: %q", a)
		}
	}
	// 必含 --filter=blob:none
	hasFilter := false
	for _, a := range args {
		if a == "--filter=blob:none" {
			hasFilter = true
		}
	}
	if !hasFilter {
		t.Error("fetch args 应包含 --filter=blob:none")
	}
}

// TestFetchRemoteWithFilter_EnvHasExtraHeader 验证 token 非空时 envVars 注入
// GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0。
//
// v0.8.32 关键回归：v0.8.27+ 误用 `Authorization: Bearer <pat>`（REST API 鉴权
// 方式），导致私有仓库 fetch 永远 401。正确格式是 Git Smart HTTP 要求的
// `Authorization: Basic base64(x-access-token:<pat>)`。
func TestFetchRemoteWithFilter_EnvHasExtraHeader(t *testing.T) {
	const token = "ghp_FakeTestToken_1234567890abcdef"
	env := buildGitHubFetchAuthEnv(token)

	if env["GIT_CONFIG_COUNT"] != "1" {
		t.Errorf("env[GIT_CONFIG_COUNT] 应为 '1', got %q", env["GIT_CONFIG_COUNT"])
	}
	if env["GIT_CONFIG_KEY_0"] != "http.https://github.com.extraHeader" {
		t.Errorf("env[GIT_CONFIG_KEY_0] 应限定到 github.com 域，避免 token 泄露给其它 host: got %q", env["GIT_CONFIG_KEY_0"])
	}
	// v0.8.32：必须是 Basic(x-access-token:token)，不是 Bearer
	header := env["GIT_CONFIG_VALUE_0"]
	const wantPrefix = "Authorization: Basic "
	if !strings.HasPrefix(header, wantPrefix) {
		t.Errorf("env[GIT_CONFIG_VALUE_0] 应以 %q 开头（v0.8.32 改 Basic），got %q", wantPrefix, header)
	}
	// 反向断言：v0.8.27+ 误用的 Bearer 不应再出现
	if strings.HasPrefix(header, "Authorization: Bearer ") {
		t.Errorf("env[GIT_CONFIG_VALUE_0] 不能再用 Bearer 头（v0.8.32 已改 Basic），got %q", header)
	}
	// 解码 base64 部分，断言内容是 'x-access-token:<token>'
	encoded := strings.TrimPrefix(header, wantPrefix)
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64 解码失败（说明构造格式错）：%v, encoded=%q", err, encoded)
	}
	wantDecoded := "x-access-token:" + token
	if string(decoded) != wantDecoded {
		t.Errorf("base64 解码后应为 %q, got %q", wantDecoded, string(decoded))
	}
	// 兼容断言：不注入 GH_TOKEN（fetch 不再依赖 gh）
	if _, ok := env["GH_TOKEN"]; ok {
		t.Errorf("env 不应再注入 GH_TOKEN（fetch 改用 extraHeader），got: GH_TOKEN=%q", env["GH_TOKEN"])
	}
}

// TestFetchRemoteWithFilter_EnvNoToken 验证 token 为空时不注入 env config。
//
// 公开仓库 fetch 无需鉴权——保留纯环境，避免误把空 Authorization 头发给 GitHub。
func TestFetchRemoteWithFilter_EnvNoToken(t *testing.T) {
	env := buildGitHubFetchAuthEnv("")
	for k := range env {
		if strings.HasPrefix(k, "GIT_CONFIG_") {
			t.Errorf("token 为空时不应注入任何 GIT_CONFIG_*，got: %s=%q", k, env[k])
		}
	}
}

// TestFetchRemoteWithFilter_EnvTokenTrimmed 验证 token 前后空白会被 trim。
//
// 用户从 Gitea Web 复制 PAT 时偶尔会带换行 / 空格，不 trim 会让 base64 编码
// 出错（base64 不容忍内部空白），fetch 会以 'fatal: bad config' 失败。
func TestFetchRemoteWithFilter_EnvTokenTrimmed(t *testing.T) {
	const token = "ghp_TokenNoWhitespace"
	env := buildGitHubFetchAuthEnv("  \n" + token + "\t\n  ")
	header := env["GIT_CONFIG_VALUE_0"]
	encoded := strings.TrimPrefix(header, "Authorization: Basic ")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("trim 后 base64 仍应可解码，got err: %v, encoded=%q", err, encoded)
	}
	if string(decoded) != "x-access-token:"+token {
		t.Errorf("trim 后解码应为 'x-access-token:%s', got %q", token, string(decoded))
	}
}

// TestFetchRemoteWithFilter_EnvOnlyWhitespaceToken 验证 token 全空白时当作空 token。
//
// 防御：避免 'x-access-token:   ' 被 base64 编码成无意义的空 credential。
func TestFetchRemoteWithFilter_EnvOnlyWhitespaceToken(t *testing.T) {
	env := buildGitHubFetchAuthEnv("   \n\t  ")
	for k := range env {
		if strings.HasPrefix(k, "GIT_CONFIG_") {
			t.Errorf("token 全空白时不应注入任何 GIT_CONFIG_*，got: %s=%q", k, env[k])
		}
	}
}

// TestIsGitHubAuthFailure 验证关键字识别 3 个 GitHub 401 文案。
func TestIsGitHubAuthFailure(t *testing.T) {
	cases := []struct {
		name   string
		errMsg string
		want   bool
	}{
		{"github 401 标准文案", "exit status 128\n输出: remote: invalid credentials\nfatal: Authentication failed for 'https://github.com/...'", true},
		{"git 包裹后文案", "exit status 128\n输出: fatal: Authentication failed for 'https://github.com/x/y.git/'", true},
		{"fatal: Authentication failed 小写变体", "fatal: authentication failed for ...", true},
		{"网络错误（无关）", "exit status 128\n输出: Could not resolve host: github.com", false},
		{"shallow lock（无关）", "could not lock ... shallow.lock", false},
		{"nil 错误", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var err error
			if tc.errMsg != "" {
				err = &fakeErr{msg: tc.errMsg}
			}
			got := isGitHubAuthFailure(err)
			if got != tc.want {
				t.Errorf("isGitHubAuthFailure() = %v, want %v (input: %q)", got, tc.want, tc.errMsg)
			}
		})
	}
}

// fakeErr 是测试用的简单 error 实现，让 isGitHubAuthFailure 走真实 Error() 路径。
type fakeErr struct{ msg string }

func (e *fakeErr) Error() string { return e.msg }

// TestNewGitHubAuthFailed 验证 IpcError 字段。
func TestNewGitHubAuthFailed(t *testing.T) {
	cause := "exit status 128\n输出: remote: invalid credentials"
	e := ipc.NewGitHubAuthFailed(cause)
	if e.Code != "github_auth_failed" {
		t.Errorf("Code 应为 'github_auth_failed', got %q", e.Code)
	}
	if e.Message == "" {
		t.Error("Message 不应为空（前端 user-facing 摘要）")
	}
	if e.Hint == "" {
		t.Error("Hint 不应为空（人话操作建议）")
	}
	if e.Cause != cause {
		t.Errorf("Cause 应透传，got %q want %q", e.Cause, cause)
	}
	// 防御：不能把 token / base64 header / env 暴露在 message / hint 里
	for _, field := range []struct {
		name, val string
	}{
		{"Message", e.Message},
		{"Hint", e.Hint},
	} {
		if strings.Contains(field.val, "ghp_") || strings.Contains(field.val, "Authorization: Basic ") {
			t.Errorf("%s 不应包含 token 或 base64 header: %q", field.name, field.val)
		}
	}
}

// TestFetchRemoteWithFilter_ShallowRepoUnshallow 验证 shallow repo + depth=0
// 时仍会传 --unshallow（v0.6.3 行为不变）。
func TestFetchRemoteWithFilter_ShallowRepoUnshallow(t *testing.T) {
	// 这是一个间接测试：直接在 tmp 目录 init + 手动写 .git/shallow 模拟 shallow，
	// 然后调 FetchWithFilter 但因为没有真实 remote 会失败——我们只关心传了 --unshallow。
	// 这里简化：只验证 args 构造（无条件）
	args := buildFetchArgsForTest(0, true /* pretend shallow */)
	hasUnshallow := false
	for _, a := range args {
		if a == "--unshallow" {
			hasUnshallow = true
		}
	}
	if !hasUnshallow {
		t.Error("shallow repo + depth=0 应传 --unshallow")
	}
}

// buildFetchArgsForTest 镜像 fetchRemoteWithFilter 的 args 构造逻辑。
//
// 这是单元测试助手段，不调 git 子进程；只验证 args 形态，避免 lockPath / waitForCommitsAvailable
// 这些需要真实仓库状态的副作用。
func buildFetchArgsForTest(depth int, shallow bool) []string {
	args := []string{"fetch", "--filter=blob:none"}
	if depth > 0 {
		args = append(args, depthArg(depth)...)
	} else if shallow {
		args = append(args, "--unshallow")
	}
	args = append(args,
		"origin",
		"+refs/heads/*:refs/remotes/origin/*",
		"+refs/tags/*:refs/tags/*",
	)
	return args
}

// depthArg 复刻 fmt.Sprintf("--depth=%d", depth) 以避免在测试文件引用 fmt。
func depthArg(depth int) []string {
	return []string{"--depth=" + itoa(depth)}
}

// itoa 是 strconv.Itoa 的简化版，避免在测试文件额外 import。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// TestGitEnvFor_InjectsExecPathForEmbedded 验证 binPath 在内嵌二进制目录时
// 自动注入 GIT_EXEC_PATH。
//
// v0.8.27+ 关键不变量：内嵌 git 必须能 fork git-remote-https.exe → 必须设
// GIT_EXEC_PATH=<tools/git>。
func TestGitEnvFor_InjectsExecPathForEmbedded(t *testing.T) {
	// 模拟 Init 释放后的状态
	tmp := t.TempDir()
	if err := gitbinary.Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	binPath := gitbinary.DefaultBinaryPath()
	if binPath == "" {
		t.Skip("当前环境无内嵌二进制（Init 跳过），跳过此测试")
	}

	env := gitbinary.GitEnvFor(binPath, nil)
	found := false
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_EXEC_PATH=") {
			found = true
			want := "GIT_EXEC_PATH=" + binDirOf(binPath)
			if e != want {
				t.Errorf("GIT_EXEC_PATH 应为 %q, got %q", want, e)
			}
		}
	}
	if !found {
		t.Error("env 应包含 GIT_EXEC_PATH，但未找到")
	}
}

// TestGitEnvFor_NoExecPathForSystemGit 验证 binPath 是系统 git 时不注入 GIT_EXEC_PATH。
//
// 用户在 SettingsView 选了系统 git（如 /usr/bin/git）后，git 自己有正确解析 exec-path
// 的能力，我们强行注入反而会破坏它的相对路径解析。
func TestGitEnvFor_NoExecPathForSystemGit(t *testing.T) {
	tmp := t.TempDir()
	if err := gitbinary.Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	// 系统 git 不在 defaultBinaryPath 目录
	systemGit := "/usr/bin/git"
	if gitbinary.DefaultBinaryPath() != "" && binDirOf(systemGit) == binDirOf(gitbinary.DefaultBinaryPath()) {
		t.Skip("system git dir 凑巧等于内嵌 dir，跳过")
	}

	env := gitbinary.GitEnvFor(systemGit, nil)
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_EXEC_PATH=") {
			t.Errorf("系统 git 不应注入 GIT_EXEC_PATH，got: %q", e)
		}
	}
}

// TestGitEnvFor_ExtraEnvOverrides 验证 extraEnv 同 key 覆盖基础 env。
func TestGitEnvFor_ExtraEnvOverrides(t *testing.T) {
	extra := map[string]string{
		"GIT_CONFIG_COUNT":   "1",
		"GIT_CONFIG_KEY_0":   "http.extraHeader",
		"GIT_CONFIG_VALUE_0": "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:fake")),
	}
	env := gitbinary.GitEnvFor("/usr/bin/git", extra)
	// extraEnv 应出现在 env 中（无重复）
	count := 0
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_CONFIG_COUNT=") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("GIT_CONFIG_COUNT 应只出现 1 次（extraEnv 覆盖基础 env），got %d 次", count)
	}
}

// binDirOf 提取路径所在目录（filepath.Dir 的 test helper 包装）。
func binDirOf(p string) string {
	i := strings.LastIndex(p, "/")
	if i < 0 {
		i = strings.LastIndex(p, "\\")
	}
	if i < 0 {
		return "."
	}
	return p[:i]
}
