package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

// PublicKeyB64 是 ed25519 公钥 base64 编码常量。
//
// 生成方式（一次性）：
//  1. go run ./cmd/sign genkey ./keys
//  2. base64 keys/gitea-kanban-public.pem | head -c 44 > pub.b64
//  3. 把 pub.b64 内容粘到下面的常量里
//
// ⚠️ 真实部署时必须替换为 v0.8.0 release 用的公钥；本常量是开发占位（对应 cmd/sign
// 生成的临时 key pair，私钥本地保存，公钥嵌 binary）。
//
// 注意：v0.7.x 之前没有这个常量，引入时必须由 maintainer 在发 v0.8.0 前替换。
var PublicKeyB64 = "PLACEHOLDER_REPLACE_WITH_BASE64_ED25519_PUBLIC_KEY_BEFORE_RELEASE"

// PublicKey 是解码后的 ed25519 公钥。
var PublicKey = func() ed25519.PublicKey {
	if PublicKeyB64 == "PLACEHOLDER_REPLACE_WITH_BASE64_ED25519_PUBLIC_KEY_BEFORE_RELEASE" {
		// 占位符期间给一个全 0 临时公钥，让 Verify 函数返 false（不 panic）。
		// 这样 v0.8.0 开发阶段启动不会炸；real release 前必须替换为真实公钥。
		return ed25519.PublicKey(make([]byte, ed25519.PublicKeySize))
	}
	raw, err := DecodePublicKey(PublicKeyB64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return ed25519.PublicKey(make([]byte, ed25519.PublicKeySize))
	}
	return ed25519.PublicKey(raw)
}()

// Verify 用 ed25519 detached signature 校验 binary 内容。
// 返 nil 表示签名匹配；否则返 ErrSignatureInvalid 或 ErrPublicKeyInvalid。
func Verify(binary, signature []byte) error {
	if len(PublicKey) != ed25519.PublicKeySize || isZeroBytes(PublicKey) {
		return ErrPublicKeyInvalid
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("%w: got %d bytes, want %d", ErrSignatureInvalid, len(signature), ed25519.SignatureSize)
	}
	if !ed25519.Verify(PublicKey, binary, signature) {
		return ErrSignatureInvalid
	}
	return nil
}

// VerifySHA256 二次校验：对下载完的 binary 算 SHA256，跟 expected hex 比对。
func VerifySHA256(binary []byte, expectedHex string) error {
	if expectedHex == "" {
		return nil // 没有 SHA256 字段时跳过（不阻断下载）
	}
	sum := sha256.Sum256(binary)
	got := hex.EncodeToString(sum[:])
	if !equalFoldHex(got, expectedHex) {
		return fmt.Errorf("%w: got %s, want %s", ErrSHA256Mismatch, got, expectedHex)
	}
	return nil
}

func equalFoldHex(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func isZeroBytes(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

// 错误码常量（前端 IPC error code 体系，对齐 AGENTS §9.3）
var (
	ErrSignatureInvalid = errors.New("update:signature invalid")
	ErrPublicKeyInvalid = errors.New("update:public key not configured")
	ErrSHA256Mismatch   = errors.New("update:sha256 mismatch")
	ErrManifestFetch    = errors.New("update:manifest fetch failed")
	ErrManifestParse    = errors.New("update:manifest parse failed")
	ErrDownloadFailed   = errors.New("update:download failed")
	ErrApplyFailed      = errors.New("update:apply failed")
	ErrPermissionDenied = errors.New("update:permission denied")
	ErrCodesignRejected = errors.New("update:codesign rejected (macOS Gatekeeper)")
	ErrManualUpdateOnly = errors.New("update:manual update only (no auto-apply)")
	ErrUnsupportedOS    = errors.New("update:unsupported OS")
)
