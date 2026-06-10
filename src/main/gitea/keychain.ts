/**
 * 系统 keychain 包装（@napi-rs/keyring AsyncEntry）
 *
 * 选型：docs/adr/0001-keychain.md
 *   M1 采用 @napi-rs/keyring@^1.3.0 + 7 个平台包。
 *   同步 Entry 在 macOS 上会阻塞主线程 → **必须**用 AsyncEntry。
 *   keytar 备选：实测与 @napi-rs/keyring 100% 互通，无需 token 迁移。
 *
 * 铁律（AGENTS.md §8.2）：
 * - 唯一 token 落盘位置——禁止写 SQLite / 文件 / 日志
 * - 错误映射：keyring-rs PlatformFailure/NoStorageAccess → KEYCHAIN_UNAVAILABLE
 *              keyring-rs AccessDenied → KEYCHAIN_ACCESS_DENIED
 *              keyring-rs NoEntry → 业务侧（按调用方决定）
 *
 * 平台覆盖：本应用承诺 7 个发布目标：
 *   darwin-x64 / darwin-arm64 / win32-x64-msvc / linux-x64-gnu / linux-x64-musl /
 *   linux-arm64-gnu / linux-arm64-musl
 *   平台包在 package.json 的 optionalDependencies 已列出。
 *
 * 业务层调用约定：
 *   import { keychainSet, keychainGet, keychainDelete, keychainFind } from './keychain.js';
 */

import { AsyncEntry, findCredentials } from '@napi-rs/keyring';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { KEYCHAIN_SERVICE_PREFIX } from '@shared/constants';

/**
 * keychain entry 句柄
 *
 * service 格式：gitea-kanban@<giteaUrl>
 * account 格式：<username>
 *
 * 多账号天然隔离——同一 giteaUrl 下不同 username 不互相覆盖。
 */
export function makeService(giteaUrl: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}${giteaUrl}`;
}

export function makeEntry(giteaUrl: string, username: string): AsyncEntry {
  return new AsyncEntry(makeService(giteaUrl), username);
}

// ===== 错误映射 =====

/**
 * 把 keyring-rs 错误映射成 IpcError
 *
 * keyring-rs 错误类型（从 @napi-rs/keyring 抛出的 message 文本推断）：
 *   - "platform failure" / "no storage access" → KEYCHAIN_UNAVAILABLE
 *   - "access denied" / "permission denied"      → KEYCHAIN_ACCESS_DENIED
 *   - "no entry"                                  → 业务层决定（这里**不**抛 IpcError，返回 null）
 *   - 其它                                       → INTERNAL
 *
 * 注：@napi-rs/keyring 的 TS 类型 Error 是 generic Error；我们用 message 匹配做兜底。
 *     v1 阶段（0.36 等）已经验证 message 格式稳定。
 */
function mapKeyringError(err: unknown, op: string): IpcError | null {
  if (!err) return null;
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes('no entry') || msg.includes('noentry')) {
    return null; // 让调用方按 null 处理
  }
  if (
    msg.includes('platform failure') ||
    msg.includes('no storage access') ||
    msg.includes('nosecret') ||
    msg.includes('no such file') ||  // libsecret shared object missing
    msg.includes('dbus') ||
    msg.includes('failed to load') ||
    msg.includes('kwallet')
  ) {
    return new IpcError({
      code: IpcErrorCode.KEYCHAIN_UNAVAILABLE,
      message: '系统 keychain 不可用',
      hint:
        'Linux：请安装 gnome-keyring 或 kwallet5；macOS：检查 Keychain Access.app 是否被禁用；Windows：检查 Credential Manager 服务',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (
    msg.includes('access denied') ||
    msg.includes('permission denied') ||
    msg.includes('accessdenied')
  ) {
    return new IpcError({
      code: IpcErrorCode.KEYCHAIN_ACCESS_DENIED,
      message: '系统拒绝了 keychain 访问权限',
      hint: '请检查系统 keychain 的访问权限设置',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  // 其它 → INTERNAL（保留原始信息）
  return new IpcError({
    code: IpcErrorCode.INTERNAL,
    message: `keychain ${op} 失败`,
    hint: '请稍后重试，或联系开发者',
    cause: err instanceof Error ? err.message : String(err),
  });
}

// ===== 业务层 API（IPC 边界调这层，不直接用 AsyncEntry） =====

/**
 * 存 token 到 keychain
 * @throws IpcError(KEYCHAIN_UNAVAILABLE | KEYCHAIN_ACCESS_DENIED | INTERNAL)
 */
export async function keychainSet(
  giteaUrl: string,
  username: string,
  token: string,
): Promise<void> {
  const entry = makeEntry(giteaUrl, username);
  try {
    await entry.setPassword(token);
  } catch (err) {
    const mapped = mapKeyringError(err, 'set');
    if (mapped) throw mapped;
    throw err;
  }
}

/**
 * 从 keychain 读 token
 * @returns token 字符串；不存在返回 null
 * @throws IpcError(KEYCHAIN_UNAVAILABLE | KEYCHAIN_ACCESS_DENIED | INTERNAL)
 */
export async function keychainGet(
  giteaUrl: string,
  username: string,
): Promise<string | null> {
  const entry = makeEntry(giteaUrl, username);
  try {
    const result = await entry.getPassword();
    return result ?? null;
  } catch (err) {
    const mapped = mapKeyringError(err, 'get');
    if (mapped) {
      if (mapped.code === IpcErrorCode.KEYCHAIN_UNAVAILABLE ||
          mapped.code === IpcErrorCode.KEYCHAIN_ACCESS_DENIED) {
        throw mapped;
      }
      // INTERNAL 也抛
      throw mapped;
    }
    // mapKeyringError 返回 null = NoEntry → 返回 null
    return null;
  }
}

/**
 * 从 keychain 删 token
 * @returns true=删了；false=本来就不存在
 * @throws IpcError(KEYCHAIN_UNAVAILABLE | KEYCHAIN_ACCESS_DENIED | INTERNAL)
 */
export async function keychainDelete(
  giteaUrl: string,
  username: string,
): Promise<boolean> {
  const entry = makeEntry(giteaUrl, username);
  try {
    const ok: unknown = await entry.deletePassword();
    return Boolean(ok);
  } catch (err) {
    const mapped = mapKeyringError(err, 'delete');
    if (mapped) {
      if (mapped.code === IpcErrorCode.KEYCHAIN_UNAVAILABLE ||
          mapped.code === IpcErrorCode.KEYCHAIN_ACCESS_DENIED) {
        throw mapped;
      }
      throw mapped;
    }
    return false;
  }
}

/**
 * 列一个 giteaUrl 下的所有 username（用于"多账号"展示）
 * @returns username 列表（**不**含 token 内容）
 */
export async function keychainFindAccounts(giteaUrl: string): Promise<string[]> {
  try {
    const creds = await findCredentials(makeService(giteaUrl));
    return creds.map((c) => c.account);
  } catch (err) {
    const mapped = mapKeyringError(err, 'find');
    if (mapped) throw mapped;
    // NoEntry / 空 → []
    return [];
  }
}

/**
 * 测试用：清理某个 giteaUrl 下所有 entry
 * （生产不暴露，**只**给单测和断开 reconnect 用）
 */
export async function keychainDeleteAllForUrl(giteaUrl: string): Promise<number> {
  const usernames = await keychainFindAccounts(giteaUrl);
  let n = 0;
  for (const u of usernames) {
    if (await keychainDelete(giteaUrl, u)) n++;
  }
  return n;
}
