/**
 * App workspace path —— 用户配置的应用本地仓库工作区根目录
 *
 * 设计（v1.5 重构：Git Graph 自动同步所选仓库到工作区）：
 * - **全局**配置（不是 per-project）；所有 gitgraph 仓库路径派生自此
 * - 持久化到 localStore.prefs['app.workspacePath']（沿用现有 prefs 通道，无需新 IPC 端点）
 * - 默认值：跨平台都用 `~/.gitea-kanban/workspace`
 *   - macOS/Linux: `${HOME}/.gitea-kanban/workspace`
 *   - Windows: `${USERPROFILE}\.gitea-kanban\workspace`
 *
 * 与现有 GITEA_KANBAN_DATA_DIR 的关系：
 *   - **不**替换 GITEA_KANBAN_DATA_DIR（那个管 state.json / cache / queue / logs）
 *   - workspacePath 单独存在，**只**给 gitgraph 仓库用
 *   - dev 模式两者都是 /tmp/gitea-kanban-dev/*（可分别覆盖）
 *
 * 安全：
 * - 只存路径字符串，**不**存 token / commit metadata
 * - 路径由 main 端 mkdir 创建（保证存在），前端不能写
 */

import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLocalStore } from './state.js';
// logger 模块顶层读 `app.isPackaged`（Electron 主进程 API）→ 在 renderer / node 测试环境 undefined
// 用动态 import 避免测试加载链崩
async function log(level: 'info' | 'warn', payload: Record<string, unknown>, msg: string): Promise<void> {
  try {
    const { logger } = (await import('../logger.js')) as { logger: { info: (p: unknown, m: string) => void; warn: (p: unknown, m: string) => void } };
    if (level === 'info') logger.info(payload, msg);
    else logger.warn(payload, msg);
  } catch {
    // 测试环境 logger 不可用（无 Electron app）→ 静默
  }
}

/** prefs key（全局 workspace 路径；非 per-project） */
export const WORKSPACE_PATH_PREF_KEY = 'app.workspacePath';

/** 默认 workspace 路径名（跨平台一致：~/.gitea-kanban/workspace） */
const DEFAULT_WORKSPACE_BASENAME = join('.gitea-kanban', 'workspace');

/**
 * 解析默认 workspace 路径
 *
 * 跨平台一致返回 `${用户主目录}/.gitea-kanban/workspace`：
 *   - macOS/Linux: `${HOME}/.gitea-kanban/workspace`
 *   - Windows: `${USERPROFILE}\.gitea-kanban\workspace`
 *
 * 注意：process.env.HOME / USERPROFILE 在 Electron renderer 进程也能拿到
 * （Electron 注入），但 main 端 homedir() 更稳。
 */
export function resolveDefaultWorkspacePath(): string {
  return join(homedir(), DEFAULT_WORKSPACE_BASENAME);
}

/**
 * 读 workspace path（来自 prefs.app.workspacePath）
 * @returns 路径字符串；不存在返 null（前端应走默认值 + 自动 set）
 */
export function getWorkspacePath(): string | null {
  try {
    const store = getLocalStore();
    const state = store.get();
    const v = state.prefs?.[WORKSPACE_PATH_PREF_KEY];
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 写 workspace path（持久化到 prefs）
 *
 * **不**自动 mkdir —— 由调用方决定何时创建（IPC handler 收到新值后 mkdir + 校验）
 */
export function setWorkspacePath(cwd: string): void {
  const store = getLocalStore();
  store.mutate((s) => {
    if (!s.prefs) s.prefs = {};
    s.prefs[WORKSPACE_PATH_PREF_KEY] = cwd;
  });
}

/**
 * 校验路径：存在 / 是目录 / 当前用户可写
 *
 * 返回 ok=false 时，UI 应弹错误让用户重新选
 */
export interface WorkspaceValidateResult {
  ok: boolean;
  reason?: string;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
}
export async function validateWorkspacePath(cwd: string): Promise<WorkspaceValidateResult> {
  const exists = existsSync(cwd);
  if (!exists) {
    return { ok: false, reason: '路径不存在', exists: false, isDirectory: false, writable: false };
  }
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      return { ok: false, reason: '不是目录', exists: true, isDirectory: false, writable: false };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `stat 失败: ${(e as Error).message}`,
      exists: true,
      isDirectory: false,
      writable: false,
    };
  }
  // 写测试：尝试创建临时文件
  try {
    const tmp = join(cwd, `.gitea-kanban-workspace-test-${Date.now()}`);
    await fs.writeFile(tmp, 'test');
    await fs.unlink(tmp);
  } catch (e) {
    return {
      ok: false,
      reason: `不可写: ${(e as Error).message}`,
      exists: true,
      isDirectory: true,
      writable: false,
    };
  }
  return { ok: true, exists: true, isDirectory: true, writable: true };
}

/**
 * 启动期 init：保证 workspace 路径已确定 + 持久化 + mkdir
 *
 * 调用场景（main 启动时）：
 *   1. localStore load 完成
 *   2. app.on('ready') → initLocalStore() 之后 → await initWorkspace()
 *   3. 检查 prefs.app.workspacePath
 *      - 有 → 校验；失败回退到默认值 + 持久化
 *      - 无 → 用默认值 + 持久化 + mkdir -p
 */
export async function initWorkspace(): Promise<{
  cwd: string;
  created: boolean;
  validated: boolean;
}> {
  let cwd = getWorkspacePath();
  let created = false;

  if (!cwd) {
    cwd = resolveDefaultWorkspacePath();
    setWorkspacePath(cwd);
    await log('info', { cwd }, 'workspace: initialized with default path');
  }

  // 确保目录存在（mkdir -p）
  if (!existsSync(cwd)) {
    try {
      await fs.mkdir(cwd, { recursive: true });
      created = true;
      await log('info', { cwd }, 'workspace: created directory');
    } catch (e) {
      await log('warn', { cwd, err: String(e) }, 'workspace: mkdir failed (continuing)');
    }
  }

  const v = await validateWorkspacePath(cwd);
  return { cwd, created, validated: v.ok };
}
