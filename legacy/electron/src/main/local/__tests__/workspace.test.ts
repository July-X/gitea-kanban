/**
 * workspace 模块单测（v1.5.3）
 *
 * 覆盖：
 * 1. resolveDefaultWorkspacePath 跨平台一致 → homedir/.gitea-kanban/workspace
 * 2. validateWorkspacePath：不存在 / 不是目录 / OK
 * 3. getWorkspacePath / setWorkspacePath 持久化（走 prefs.app.workspacePath）
 *
 * 用 GITEA_KANBAN_DATA_DIR 隔离（避免污染真实 ~/.gitea-kanban）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDefaultWorkspacePath,
  getWorkspacePath,
  setWorkspacePath,
  validateWorkspacePath,
  WORKSPACE_PATH_PREF_KEY,
} from '@main/local/workspace';
import { initLocalStore, _resetLocalStoreForTest } from '@main/local/state';

const ENV_KEY = 'GITEA_KANBAN_DATA_DIR';
let savedEnv: string | undefined;
let testDir: string;

beforeEach(async () => {
  savedEnv = process.env[ENV_KEY];
  testDir = join(tmpdir(), `gitea-kanban-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env[ENV_KEY] = testDir;
  mkdirSync(testDir, { recursive: true });
  await _resetLocalStoreForTest();
  await initLocalStore();
});

afterEach(async () => {
  await _resetLocalStoreForTest();
  if (savedEnv !== undefined) process.env[ENV_KEY] = savedEnv;
  else delete process.env[ENV_KEY];
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('workspace · resolveDefaultWorkspacePath 跨平台一致', () => {
  it('macOS/Linux: 默认 = ${homedir}/.gitea-kanban/workspace', () => {
    const p = resolveDefaultWorkspacePath();
    expect(p).toBe(join(homedir(), '.gitea-kanban', 'workspace'));
  });

  it('返回的是绝对路径（不在 tmpdir / cwd 内）', () => {
    const p = resolveDefaultWorkspacePath();
    expect(p).toMatch(new RegExp(`^${homedir()}`));
  });
});

describe('workspace · validateWorkspacePath', () => {
  it('不存在的路径 → ok=false, reason=路径不存在', async () => {
    const v = await validateWorkspacePath('/tmp/gitea-kanban-__nonexistent__');
    expect(v.ok).toBe(false);
    expect(v.exists).toBe(false);
    expect(v.reason).toMatch(/不存在/);
  });

  it('是文件不是目录 → ok=false, reason=不是目录', async () => {
    const filePath = join(testDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'test');
    const v = await validateWorkspacePath(filePath);
    expect(v.ok).toBe(false);
    expect(v.exists).toBe(true);
    expect(v.isDirectory).toBe(false);
    expect(v.reason).toMatch(/不是目录/);
  });

  it('存在的空目录 + 可写 → ok=true', async () => {
    const dir = join(testDir, 'workspace');
    mkdirSync(dir, { recursive: true });
    const v = await validateWorkspacePath(dir);
    expect(v.ok).toBe(true);
    expect(v.exists).toBe(true);
    expect(v.isDirectory).toBe(true);
    expect(v.writable).toBe(true);
  });
});

describe('workspace · getWorkspacePath / setWorkspacePath 持久化', () => {
  it('未设置时 getWorkspacePath 返 null', () => {
    expect(getWorkspacePath()).toBeNull();
  });

  it('setWorkspacePath 后 getWorkspacePath 返相同字符串', () => {
    setWorkspacePath('/tmp/test-workspace');
    expect(getWorkspacePath()).toBe('/tmp/test-workspace');
  });

  it('prefs key 命名约定', () => {
    expect(WORKSPACE_PATH_PREF_KEY).toBe('app.workspacePath');
  });

  it('空字符串被视为未设置（getWorkspacePath 返 null；校验在 handler 层）', () => {
    setWorkspacePath('');
    // getWorkspacePath 有意过滤空字符串 → 返 null（符合业务：空 = 未设置）
    expect(getWorkspacePath()).toBeNull();
  });
});
