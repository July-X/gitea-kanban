/**
 * gitea HTTP 客户端工厂
 *
 * 选型：openapi-fetch + 手写 TS 类型（02-architecture.md §2.3）
 *
 * 设计：
 * - 工厂：按 (giteaUrl, username) 缓存 openapi-fetch 实例
 * - 不缓存 token：每次请求临时从 keychain 读，token 5 min 内存缓存由 caller 控制
 * - 拦截器：把 HTTP 错误码 + 业务码统一转 IpcError
 *
 * 铁律（AGENTS.md §8.2 鉴权铁律）：
 * - token 永远在主进程内存
 * - 渲染进程拿不到 token
 * - keychain 唯一落盘位置
 *
 * v1：本文件只暴露 client 工厂 + 一个 `giteaFetch(giteaUrl, username, path, opts)` helper
 *     Plan 2 起在 src/main/gitea/{repos,branches,commits,pulls,issues}.ts 加业务包装
 */

import createClient, { type Middleware } from 'openapi-fetch';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { keychainGet } from './keychain.js';

/** openapi-fetch 实际是 fetch 的 thin wrapper；用 generic <TPaths> 跳过类型生成
 *  （v1 不接入 gitea OpenAPI 生成的强类型；将来要接入时改用 generate-types 产物） */
type GiteaClient = ReturnType<typeof createClient<Record<string, never>>>;

interface ClientEntry {
  client: GiteaClient;
  baseUrl: string;
  token?: string;
  tokenFetchedAt: number;
}

const cache = new Map<string, ClientEntry>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function cacheKey(giteaUrl: string, username: string): string {
  return `${giteaUrl}::${username}`;
}

/**
 * 把 HTTP 错误映射成 IpcError
 */
function httpErrorToIpcError(
  status: number,
  body: unknown,
  fallbackMessage: string,
): IpcError {
  const cause = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  switch (status) {
    case 401:
      return new IpcError({
        code: IpcErrorCode.TOKEN_INVALID,
        message: '登录已过期或 token 无效',
        hint: '请到 gitea 重新生成 token 后重新连接',
        cause,
        httpStatus: 401,
      });
    case 403:
      return new IpcError({
        code: IpcErrorCode.PERMISSION_DENIED,
        message: '没有该操作权限',
        hint: '请联系仓库管理员',
        cause,
        httpStatus: 403,
      });
    case 404:
      return new IpcError({
        code: IpcErrorCode.NOT_FOUND,
        message: '找不到该资源（可能已被删除）',
        hint: '请刷新列表',
        cause,
        httpStatus: 404,
      });
    case 409:
      return new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: '操作冲突：资源已存在或状态不允许',
        cause,
        httpStatus: 409,
      });
    case 429:
      return new IpcError({
        code: IpcErrorCode.RATE_LIMITED,
        message: '请求过于频繁，已自动重试',
        hint: '请稍后重试',
        cause,
        httpStatus: 429,
      });
    case 0:
    case 502:
    case 503:
    case 504:
      return new IpcError({
        code: IpcErrorCode.NETWORK_OFFLINE,
        message: '当前离线或远端不可达',
        hint: '请检查网络后重试',
        cause,
        httpStatus: status,
      });
    default:
      return new IpcError({
        code: IpcErrorCode.GITEA_ERROR,
        message: fallbackMessage,
        cause,
        httpStatus: status,
      });
  }
}

/**
 * 内部：根据 giteaUrl 截掉尾斜杠（gitea URL 容忍：/api/v1 都 ok）
 */
function normalizeBaseUrl(giteaUrl: string): string {
  return giteaUrl.replace(/\/+$/, '');
}

/**
 * 拿一个 client 入口（{ baseUrl, token }）
 *
 * 实现说明（2026-06-11）：
 * - openapi-fetch 0.17 的 createClient 不暴露 baseUrl 到返回的 client 实例上
 *   （baseUrl 是 createClient 内部闭包变量）
 * - 业务侧 giteaFetch 不再走 openapi-fetch（client.raw 根本不存在）
 *   改用 globalThis.fetch + baseUrl + token
 * - 这里仍然占位创建 openapi-fetch client，保留接口向后兼容；
 *   未来接入 gitea OpenAPI generate-types 时可以拿这个 client 直接 GET/POST
 *
 * 注意：openapi-fetch 内部不缓存 token；我们自己做 5 min 内存缓存
 *
 * 抛 KEYCHAIN_UNAVAILABLE / KEYCHAIN_ACCESS_DENIED 透传
 */
export async function getGiteaClient(
  giteaUrl: string,
  username: string,
): Promise<{ baseUrl: string; token?: string }> {
  const key = cacheKey(giteaUrl, username);
  const now = Date.now();
  let entry = cache.get(key);

  // token 是否需要刷新
  const needRefresh = !entry || !entry.token || now - entry.tokenFetchedAt > TOKEN_CACHE_TTL_MS;
  if (needRefresh) {
    const token = await keychainGet(giteaUrl, username);
    if (!token) {
      throw new IpcError({
        code: IpcErrorCode.UNAUTHENTICATED,
        message: '请先在 设置 → 账户 连接 gitea',
        hint: '跳转到连接页',
      });
    }
    if (!entry) {
      // 首次创建 entry：baseUrl 留个备份给 giteaFetch；openapi-fetch client 占位（未来用）
      entry = {
        client: createClient<Record<string, never>>({ baseUrl: normalizeBaseUrl(giteaUrl) }),
        baseUrl: normalizeBaseUrl(giteaUrl),
        tokenFetchedAt: 0,
      };
      cache.set(key, entry);
    }
    entry.token = token;
    entry.tokenFetchedAt = now;
    // 重新装 token 中间件（openapi-fetch 未来要用）
    rewireAuth(entry, token);
  }
  // 业务侧 giteaFetch 只用 { baseUrl, token }；client 字段保留给未来 OpenAPI 集成
  return { baseUrl: entry!.baseUrl, token: entry!.token };
}

function rewireAuth(entry: ClientEntry, token: string): void {
  // openapi-fetch 中间件：每次请求设 Authorization
  const authMiddleware: Middleware = {
    async onRequest({ request }) {
      request.headers.set('Authorization', `token ${token}`);
      request.headers.set('Accept', 'application/json');
      return request;
    },
    async onResponse({ request, response }) {
      if (!response.ok) {
        // 401 → 强制清 token 缓存（下次会重读 keychain）
        if (response.status === 401) {
          const key = [...cache.entries()].find(
            ([, v]) => v.client === (request as unknown as { client: GiteaClient })?.client,
          )?.[0];
          if (key) cache.delete(key);
        }
      }
      return response;
    },
  };
  // openapi-fetch: set 替换整个中间件链
  entry.client.use(authMiddleware);
}

/**
 * 顶层 fetch helper：把 openapi-fetch 的复杂 API 收成一个简单调用
 *
 * 业务侧用法：
 *   const user = await giteaFetch<User>(giteaUrl, username, '/user', { method: 'GET' });
 *
 * 错误：抛 IpcError（httpErrorToIpcError 映射）
 *
 * 实现说明（2026-06-11）：
 * - 之前用 openapi-fetch 的 client.raw()，但 openapi-fetch 0.13 / 0.17 都没有 .raw
 *   这个公开 API（只有 GET/POST/PUT/DELETE/HEAD/PATCH/OPTIONS/TRACE 加上 .request()）
 * - 直接用 globalThis.fetch + baseUrl + path + token，绕开 openapi-fetch
 * - openapi-fetch 仍然作为依赖保留（将来接入 gitea OpenAPI generate-types 时复用）
 *   但本文件实际不再调用它
 */
export async function giteaFetch<T = unknown>(
  giteaUrl: string,
  username: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string> } = {},
): Promise<T> {
  // getGiteaClient 拿 baseUrl + 缓存的 token（不依赖 openapi-fetch 的 client 实例）
  const client = (await getGiteaClient(giteaUrl, username)) as unknown as { baseUrl: string; token?: string };
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const query = init.query
    ? Object.fromEntries(
        Object.entries(init.query).filter(([, v]) => v !== undefined) as Array<[string, string | number | boolean]>,
      )
    : undefined;

  // 拼 URL：baseUrl + /api/v1 + path + (optional) query
  // （注意：new URL(absolutePath, base) 会**覆盖** base 的 path，所以 path 必须是**相对**路径（去掉前导 /））
  const baseWithApi = `${client.baseUrl.replace(/\/+$/, '')}/api/v1/`;
  // 去掉前导 / 让 path 成为相对路径
  const relPath = normalizedPath.replace(/^\/+/, '');
  const u = new URL(relPath, baseWithApi);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      u.searchParams.set(k, String(v));
    }
  }

  const res = await globalThis.fetch(u.toString(), {
    method: init.method ?? 'GET',
    ...(init.body !== undefined
      ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }
      : {}),
    headers: {
      Accept: 'application/json',
      Authorization: `token ${client.token ?? ''}`,
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    throw httpErrorToIpcError(res.status, body, `gitea ${normalizedPath} 失败`);
  }

  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

/** 清空 client 缓存（disconnect / token 失效后） */
export function clearGiteaClientCache(): void {
  cache.clear();
}

/** 清掉某个 (giteaUrl, username) 的缓存 */
export function invalidateGiteaClient(giteaUrl: string, username: string): void {
  cache.delete(cacheKey(giteaUrl, username));
}

// 导出供测试的内部函数
export const _testInternals = {
  cacheKey,
  normalizeBaseUrl,
  httpErrorToIpcError,
};
