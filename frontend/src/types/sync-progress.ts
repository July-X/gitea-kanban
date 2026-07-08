/**
 * 共享类型：git sync 进度事件（前端）
 *
 * 与 Go 端 app.GitSyncProgressPayload + app/git.SyncProgress 字段一一对应
 * （Wails 不会自动暴露 Go struct 给前端，TS 这边手动声明更稳）。
 *
 * 字段含义：
 *   - Stage:进度阶段（counting / compressing / receiving / resolving / checkout / updating / done / error / unknown）
 *     对齐 go-git sideband 第一列文本
 *   - Percent:0..100，-1 表示未知（阶段刚开始、还没出百分比）
 *   - Cur / Total:当前阶段的 cur/total 项数（clone 时是对象数，pull 时是 commit 数）
 *   - Message:原始 sideband 文本（透传给前端展示 / 调试用）
 *   - RepoKey:仓库标识，对齐 clonedMap 的 `${owner}/${repo}` key（前端用它 map 到具体行）
 */

export type GitSyncStage =
  | 'unknown'
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checkout'
  | 'updating'
  | 'done'
  | 'error';

export interface SyncProgress {
  stage: GitSyncStage;
  percent: number;
  message: string;
  cur: number;
  total: number;
  repoKey: string;
}

export interface GitSyncProgressPayload extends SyncProgress {}

/** Wails event name（与 Go 端 const GitSyncProgressEvent 同步） */
export const GitSyncProgressEvent = 'git:sync:progress';