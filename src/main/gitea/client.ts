/**
 * gitea HTTP客户端（基于 gitea-js +兼容 giteaFetch fallback）
 *
 *选型：gitea-js1.23.0（swagger 自动生成 TS客户端，ADR-0002 §"gitea-js引入"）
 * -零运行时依赖（deps:none）
 * - 由 gitea官方 swagger.json派生类型，业务侧直接拿到 typed Issue/Label/PullRequest 等
 * - HttpResponse extends Response：不抛错，返 .ok + .data + .status
 * - 我们在外面 wrap 到 IpcError（统一401/403/404/409/429/5xx映射）
 *
 * 设计：
 * -工厂：按 (giteaUrl, username)缓存 Api 实例
 * - token：每次请求临时从 keychain读，5 min内存缓存由本类控制
 * -拦截器：把 HTTP错误码 +业务码统一转 IpcError
 *
 *铁律（AGENTS.md §8.2鉴权铁律）：
 * - token永远在主进程内存
 * -渲染进程拿不到 token
 * - keychain唯一落盘位置
 *
 * 注：gitea-js 默认用 `Bearer ${token}` Authorization头；
 * 但 gitea实际是 `token ${pat}`（这是 gitea1.x历史字段，不是 OAuth2 Bearer）。
 * 我们 override securityWorker改写 Authorization头。
 *
 * **兼容性**：
 * - 新代码走 `getGiteaClient() + gitea-js Api方法`（typed）
 * -旧代码（auth.ts / seed-kanban-demo.ts / tests / m2-e2e）走 `giteaFetch<T>(path)` —— fallback，保留向后兼容
 * -后续测试逐步迁移到 gitea-js Api（不在本任务范围）
 *
 * 历史（2026-06-11 ADR-0002）：
 * -删 openapi-fetch（gitea-js1.23.0 swagger生成更全）
 * -删手写 Gitea*Raw类型（gitea-js 自动导 Issue/Label 等）
 * -保留 giteaFetch（fallback 给 tests/scripts）
 */

import { Api, type HttpResponse } from 'gitea-js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import { keychainGet } from './keychain.js';

interface ClientEntry {
 api: Api<unknown>;
 baseUrl: string;
 token?: string;
 tokenFetchedAt: number;
}

const cache = new Map<string, ClientEntry>();
const TOKEN_CACHE_TTL_MS =5 *60 *1000; //5 min

function cacheKey(giteaUrl: string, username: string): string {
 return `${giteaUrl}::${username}`;
}

/**
 * 把 HTTP错误映射成 IpcError
 */
export function httpErrorToIpcError(
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
 hint: '请到 gitea重新生成 token 后重新连接',
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
 case 422:
 return new IpcError({
 code: IpcErrorCode.VALIDATION_FAILED,
 message: '请求参数不被服务端接受',
 hint: '请检查输入内容',
 cause,
 httpStatus: 422,
 });
 case 429:
 return new IpcError({
 code: IpcErrorCode.RATE_LIMITED,
 message: '请求过于频繁',
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
 *内部：根据 giteaUrl截掉尾斜杠（gitea URL容忍：/api/v1 都 ok）
 */
function normalizeBaseUrl(giteaUrl: string): string {
 return giteaUrl.replace(/\/+$/, '');
}

/**
 * gitea-js安全头 override：把默认 `Bearer ${token}`改成 gitea习惯的 `token ${pat}`
 *
 * gitea1.x用 `Authorization: token <pat>`（不是 OAuth2 Bearer）
 * 2026-06-11验证：gitea-js1.23.0 的 securityWorker默认输出 Bearer → 不适配 gitea → override
 */
function makeGiteaSecurityWorker() {
  return async (securityData: unknown) => {
  if (!securityData) return;
  return {
  secure: true,
  headers: {
  Authorization: `token ${String(securityData)}`,
  },
  };
  };
}

/**
 *拿一个 Api 实例 + token（新代码主用这个）
 *
 * 实现说明：
 * - 按 (giteaUrl, username) cache Api 实例（gitea-js内部无状态缓存）
 * - token5 min内存缓存（避免每个 IPC 都读 keychain）
 * - 用 api.setSecurityData(token) 把 token注入 securityWorker
 *
 *抛 KEYCHAIN_UNAVAILABLE / KEYCHAIN_ACCESS_DENIED透传
 */
export async function getGiteaClient(
 giteaUrl: string,
 username: string,
): Promise<{ api: Api<unknown>; baseUrl: string; token?: string }> {
 const key = cacheKey(giteaUrl, username);
 const now = Date.now();
 let entry = cache.get(key);

 // token是否需要刷新
 const needRefresh = !entry || !entry.token || now - entry.tokenFetchedAt > TOKEN_CACHE_TTL_MS;
 if (needRefresh) {
 const token = await keychainGet(giteaUrl, username);
 if (!token) {
 throw new IpcError({
 code: IpcErrorCode.UNAUTHENTICATED,
 message: '请先在 设置 →账户 连接 gitea',
 hint: '跳转到连接页',
 });
 }
  if (!entry) {
  //首次创建 entry：直接 new Api() 绕开 giteaApi factory 的内置 securityWorker
  //（factory 写死 Bearer ${options.token}，覆盖我们传的 worker；gitea 习惯 token ${pat} 走不通）
  //自己 new + 自定义 securityWorker + setSecurityData() 路径完整保留
  entry = {
  api: new Api({
  baseUrl: `${normalizeBaseUrl(giteaUrl)}/api/v1`,
  baseApiParams: { format: 'json' },
  securityWorker: makeGiteaSecurityWorker(),
  }),
  baseUrl: normalizeBaseUrl(giteaUrl),
  tokenFetchedAt:0,
  };
  cache.set(key, entry);
  }
 entry.token = token;
 entry.tokenFetchedAt = now;
 entry.api.setSecurityData(token);
 }
 if (!entry) {
 // should not happen: just initialized above; defensive
 throw new IpcError({
 code: IpcErrorCode.GITEA_ERROR,
 message: 'getGiteaClient cache state corruption',
 });
 }
 return { api: entry.api, baseUrl: entry.baseUrl, token: entry.token };
}

/**
 *顶层 fetch helper：兼容旧代码（auth / tests / seed / m2-e2e）
 *
 * - 不走 gitea-js Api（避开 import链）—— 直接 globalThis.fetch + baseUrl + token
 * -同样按 (giteaUrl, username) cache token5 min
 * -抛 IpcError（httpErrorToIpcError映射）
 *
 *业务侧用法（**旧代码**）：
 * const user = await giteaFetch<User>(giteaUrl, username, '/user', { method: 'GET' });
 *
 * 注：新业务代码用 getGiteaClient() + gitea-js Api方法，不要再用 giteaFetch。
 */
export async function giteaFetch<T = unknown>(
 giteaUrl: string,
 username: string,
 path: string,
 init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string> } = {},
): Promise<T> {
 const client = await getGiteaClient(giteaUrl, username);
 const normalizedPath = path.startsWith('/') ? path : `/${path}`;
 const query = init.query
 ? Object.fromEntries(
 Object.entries(init.query).filter(([, v]) => v !== undefined) as Array<[string, string | number | boolean]>,
 )
 : undefined;

 //拼 URL：baseUrl + /api/v1 + path + (optional) query
 const baseWithApi = `${client.baseUrl.replace(/\/+$/, '')}/api/v1/`;
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
 throw httpErrorToIpcError(res.status, body, `gitea ${normalizedPath}失败`);
 }

 if (res.status ===204) return null as T;
 return (await res.json()) as T;
}

/** 清空 client缓存（disconnect / token失效后） */
export function clearGiteaClientCache(): void {
 cache.clear();
}

/** 清掉某个 (giteaUrl, username) 的缓存 */
export function invalidateGiteaClient(giteaUrl: string, username: string): void {
 cache.delete(cacheKey(giteaUrl, username));
}

/**
 * 业务侧 helper：把 gitea-js HttpResponse包成"成功时取 data，失败时 throw IpcError"
 *
 * 用法：
 * const res = await api.issue.issueListIssues(owner, repo, query);
 * const issues = unwrapGitea(res, '/repos/.../issues');
 *
 * 注：gitea-js 的 HttpResponse<D, E> 继承自 Response 并有 data: D；这里直接读 res.data
 * 类型从 res.data 自动推断，无需显式 T
 */
export function unwrapGitea<TData, TError = unknown>(
  res: HttpResponse<TData, TError>,
  fallbackMessage: string,
): TData {
  if (!res.ok) {
  // gitea 错误响应是 JSON {message, url?}，TError 默认 unknown 时 res.data?.message 是 string
  // 兜底链：res.data.message -> res.data.error -> res.statusText -> "HTTP <status>"
  const data = res.data as unknown;
  const dataObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  const errObj = (dataObj && typeof dataObj['error'] === 'object' && dataObj['error'] !== null)
  ? (dataObj['error'] as Record<string, unknown>)
  : null;
  const cause =
  (typeof dataObj?.['message'] === 'string' && (dataObj['message'] as string)) ||
  (typeof errObj?.['message'] === 'string' && (errObj['message'] as string)) ||
  (res.statusText || `HTTP ${res.status}`);
  throw httpErrorToIpcError(res.status, cause, fallbackMessage);
  }
  return res.data;
}

//导出供测试的内部函数
export const _testInternals = {
 cacheKey,
 normalizeBaseUrl,
 httpErrorToIpcError,
 makeGiteaSecurityWorker,
};
