// Package ipc 定义 Wails binding 错误格式。
//
// 设计（对齐 frontend/src/shared/errors.ts 的 IpcErrorPayload）：
//   - Go 端方法返回 *IpcError 时，main.go 注册的 ErrorFormatter 把结构化字段
//     （code/message/hint/cause/httpStatus）注入到 Wails CallbackMessage.Err 里
//   - 渲染端 ipc-client.ts 的 isIpcErrorPayload() + normalizeError() 就能识别
//
// 不需要 ErrorFormatter 的场景：
//   - 普通 fmt.Errorf("...") → Wails 自动 err.Error() → 渲染端拿 Error(message="...")
//   - 这种错误会被 normalizeError 走 "internal" 兜底分支，提示"应用出错了：xxx"
//
// 关键约束：
//   - 必须实现 error 接口（Error() string）
//   - JSON tag 用 camelCase 与前端 IpcErrorPayload 对齐
//   - ErrorFormatter 设置后所有 binding 方法的 error 都会被它处理
//   - 非 IpcError 的 error 走 .Error() 字符串兜底
package ipc

import (
	"errors"
	"strings"
)

// IpcError 业务错误（实现 error，可被 Wails ErrorFormatter 序列化）
//
// 与 frontend/src/shared/errors.ts 的 IpcErrorPayload 字段一一对应。
type IpcError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Hint       string `json:"hint,omitempty"`
	Cause      string `json:"cause,omitempty"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
}

// Error 实现 error 接口
func (e *IpcError) Error() string {
	if e.Hint != "" {
		return e.Message + "（" + e.Hint + "）"
	}
	return e.Message
}

// ===== 12 个业务错误码常量（与 frontend/src/shared/errors.ts IpcErrorCode 对齐）=====

const (
	CodeUnauthenticated      = "unauthenticated"
	CodeTokenInvalid         = "token_invalid"
	CodePermissionDenied     = "permission_denied"
	CodeNotFound             = "not_found"
	CodeConflict             = "conflict"
	CodeRateLimited          = "rate_limited"
	CodeNetworkOffline       = "network_offline"
	CodeGiteaError           = "gitea_error"
	CodeValidationFailed     = "validation_failed"
	CodeInternal             = "internal"
	CodeKeychainUnavailable  = "keychain_unavailable"
	CodeKeychainAccessDenied = "keychain_access_denied"
)

// NewUnauthenticated 401 / token 失效
func NewUnauthenticated(cause string) *IpcError {
	return &IpcError{
		Code:    CodeUnauthenticated,
		Message: "登录已过期或 token 无效",
		Hint:    "请到 Gitea 重新生成 token 后再连接",
		Cause:   cause,
	}
}

// NewPermissionDenied 403
func NewPermissionDenied(cause string) *IpcError {
	return &IpcError{
		Code:    CodePermissionDenied,
		Message: "没有该操作权限",
		Hint:    "请联系仓库管理员",
		Cause:   cause,
	}
}

// NewNotFound 404
func NewNotFound(cause string) *IpcError {
	return &IpcError{
		Code:    CodeNotFound,
		Message: "找不到该资源",
		Hint:    "可能已被删除，请刷新列表",
		Cause:   cause,
	}
}

// NewNetworkOffline 网络断开 / 5xx
func NewNetworkOffline(cause string) *IpcError {
	return &IpcError{
		Code:    CodeNetworkOffline,
		Message: "当前离线或远端不可达",
		Hint:    "请检查网络后重试",
		Cause:   cause,
	}
}

// NewValidationFailed 参数校验失败
func NewValidationFailed(message, cause string) *IpcError {
	return &IpcError{
		Code:    CodeValidationFailed,
		Message: message,
		Hint:    "请检查输入参数",
		Cause:   cause,
	}
}

// NewInternal 兜底错误
func NewInternal(cause string) *IpcError {
	return &IpcError{
		Code:    CodeInternal,
		Message: "应用出错了",
		Hint:    "请稍候重试或重启应用",
		Cause:   cause,
	}
}

// NewKeychainUnavailable 系统 keychain 不可用
func NewKeychainUnavailable(cause string) *IpcError {
	return &IpcError{
		Code:    CodeKeychainUnavailable,
		Message: "本机密钥库不可用",
		Hint:    "Linux 需要安装 gnome-keyring 或 kwallet；macOS/Windows 通常可用",
		Cause:   cause,
	}
}

// NewKeychainAccessDenied 系统 keychain 拒绝访问
func NewKeychainAccessDenied(cause string) *IpcError {
	return &IpcError{
		Code:    CodeKeychainAccessDenied,
		Message: "本机密钥库拒绝访问",
		Hint:    "请在系统授权弹窗中允许本应用访问密钥库",
		Cause:   cause,
	}
}

// NewGiteaError 通用 Gitea 业务错误
func NewGiteaError(message, cause string) *IpcError {
	return &IpcError{
		Code:    CodeGiteaError,
		Message: message,
		Hint:    "请稍候重试",
		Cause:   cause,
	}
}

// NewUnsupportedPlatform 平台不支持（GitHub 首期很多功能不支持）
func NewUnsupportedPlatform(platform string) *IpcError {
	return &IpcError{
		Code:    CodeNotFound,
		Message: "该平台暂不支持此功能",
		Hint:    "GitHub 首期仅支持 Git Graph，请到时间轴页操作",
		Cause:   "platform=" + platform,
	}
}

// ===== HTTP 状态码 → IpcError 转换（与旧 frontend/src/main/gitea/client.ts httpErrorToIpcError 对齐）=====

// FromHTTPStatus 把 HTTP 状态码转成 IpcError
//
// 保证每个返回的 *IpcError 都带上 HTTPStatus（前端 httpStatus 字段），
// 方便后续做"按 HTTP 状态码分桶的告警 / 重试策略"。
func FromHTTPStatus(status int, body string) *IpcError {
	cause := TruncateCause(body)
	withStatus := func(err *IpcError) *IpcError {
		err.HTTPStatus = status
		return err
	}
	switch status {
	case 401:
		return withStatus(&IpcError{
			Code:    CodeTokenInvalid,
			Message: "登录已过期或 token 无效",
			Hint:    "请到 Gitea 重新生成 token 后再连接",
			Cause:   cause,
		})
	case 403:
		return withStatus(NewPermissionDenied(cause))
	case 404:
		return withStatus(NewNotFound(cause))
	case 409:
		return withStatus(&IpcError{
			Code:    CodeConflict,
			Message: "操作冲突",
			Hint:    "资源已存在或状态不允许",
			Cause:   cause,
		})
	case 422:
		return withStatus(NewValidationFailed("请求参数不被服务端接受", cause))
	case 429:
		return withStatus(&IpcError{
			Code:    CodeRateLimited,
			Message: "请求过于频繁",
			Hint:    "请稍候重试",
			Cause:   cause,
		})
	case 502, 503, 504:
		return withStatus(NewNetworkOffline(cause))
	default:
		return withStatus(NewGiteaError("Gitea 返回 "+itoa(status), cause))
	}
}

// TruncateCause 把 cause 截断到 200 字符（避免日志/UI 暴长）
func TruncateCause(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}

// itoa 把 int 转 string（避免 strconv 导入依赖）
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// FormatError 是 main.go 传给 wails.Run 的 ErrorFormatter
//
// 行为：
//   - err 是 *IpcError 或包装了 *IpcError 的 error → 返回结构体
//     （Wails 把它 JSON 化进 CallbackMessage.Err）
//   - 其他 error → 走 .Error() 字符串兜底（前端 normalizeError 走 "internal" 分支）
//
// 这样所有 *IpcError 业务错误能完整带 code/message/hint 到达前端，
// 非业务错误（开发期 bug / 第三方库 panic 等）退化为 internal。
func FormatError(err error) any {
	if err == nil {
		return nil
	}
	// 用 errors.As 支持 fmt.Errorf("...: %w", ipcErr) 这种包装
	var ipcErr *IpcError
	if errors.As(err, &ipcErr) {
		return ipcErr
	}
	return err.Error()
}