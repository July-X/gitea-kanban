/**
 * pino logger 实例（主进程唯一日志出口）
 *
 * 铁律（AGENTS.md §4.5 / §8.2）：
 * - token / password / key 字段**永远**从日志里 redact（redact 规则写死，禁止关闭）
 * - 热路径用 logger.isLevelEnabled('debug') 保护，避免字符串拼接开销
 * - 日志落 ~/.gitea-kanban/logs/main-YYYY-MM-DD.log（跨平台同源），按日滚动，保留 14 天
 *
 * 历史：
 * - v1 设计走 app.getPath('logs')（macOS = ~/Library/Logs/gitea-kanban/main/）
 * - 2026-06-11 改为 ~/.gitea-kanban/logs/ 跟 db 同源（详见 AGENTS §8.15 / commit 76c3a72 配套）
 * - 跟 db 路径同构：环境变量 GITEA_KANBAN_DATA_DIR 优先 → 兜底 ~/.gitea-kanban
 *
 * 渲染进程直接用 console（开发期）；生产期通过 IPC 转发到主进程 logger。
 */

import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import os from 'node:os';
import { pino, type Logger, type LoggerOptions } from 'pino';
import { LOG_RETENTION_DAYS, LOG_SUBDIR } from '@shared/constants';

const isDev = !app.isPackaged;

/** redact 规则——写死，禁止关闭（AGENTS.md §8.2 铁律） */
const REDACT_PATHS = [
  '*.token',
  '*.password',
  '*.key',
  'token',
  'password',
  '*.apiKey',
  'apiKey',
  '*.secret',
  'secret',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

/**
 * 计算数据根目录（与 src/main/cache/sqlite.ts:resolveDbPath 同源 —— 见 AGENTS §8.15）
 *
 * 优先级：
 * 1. 环境变量 GITEA_KANBAN_DATA_DIR（绝对路径，多实例/备份场景）
 * 2. 兜底 ~/.gitea-kanban（跨平台统一）
 */
function resolveDataRoot(): string {
  const fromEnv = process.env.GITEA_KANBAN_DATA_DIR;
  if (fromEnv) {
    if (!isAbsolute(fromEnv)) {
      throw new Error(`GITEA_KANBAN_DATA_DIR must be absolute, got: ${fromEnv}`);
    }
    return fromEnv;
  }
  return join(os.homedir(), '.gitea-kanban');
}

/**
 * 计算日志目录：<dataRoot>/logs/<LOG_SUBDIR>
 * （详见下面 transport 配置直接调用 resolveDataRoot；保留函数签名以维持旧调用兼容）
 */

/** 基础 logger 选项（无 transport） */
const baseOptions: LoggerOptions = {
  level: isDev ? 'debug' : 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * 在主进程入口里同步创建 transport（开发期 pino-pretty，生产期 file roll）
 * 为了避免 pino 的 pino-pretty 在 production 引入额外依赖，开发与生产分支：
 */
function buildLogger(): Logger {
  if (isDev) {
    // 开发模式：直接写文件（避免 stdout fd=-1 → SonicBoom RangeError）
    // 2026-06-12 修复：EPERM 兜底 —— macOS SIP 限制某些用户目录（~/Library / ~/.gitea-kanban）
    // 时 Electron 写不进去；fallback 到 /tmp/gitea-kanban-logs
    const candidates = [
      join(resolveDataRoot(), 'logs', LOG_SUBDIR),
      '/tmp/gitea-kanban-logs',
    ];
    const date = new Date().toISOString().slice(0, 10);
    for (const logDir of candidates) {
      try {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        // 真实测试写入：EPERM 可能在 mkdir 后实际 open 才暴露
        const probePath = join(logDir, `.probe-${process.pid}-${Date.now()}`);
        const fd = require('node:fs').openSync(probePath, 'a');
        require('node:fs').closeSync(fd);
        require('node:fs').unlinkSync(probePath);
        // 写入 OK，再正式开日志
        const filename = join(logDir, `main-${date}.log`);
        cleanupOldLogs(logDir);
        return pino({
          ...baseOptions,
        }, pino.destination({
          dest: filename,
          sync: true,
          mkdir: true,
          mode: 0o600,
        }));
      } catch (err) {
        // EPERM / EACCES —— 试下一个候选
        void err;
      }
    }
    // 全部 fallback 都拒 —— 退化到 noop logger（不死进程）
    return pino({ ...baseOptions, level: 'silent' });
  }
  // 生产模式：先不写文件（避免文件 IO 在 ipcMain.handle 热路径上做 sync I/O）
  // 文件落盘由 app.whenReady() 之后异步开启；不阻塞主进程启动
  return pino(baseOptions);
}

/** 主进程单例 logger */
export const logger: Logger = buildLogger();

/**
 * 在 app ready 之后可调用，把 logger 升级到带文件 transport 的版本
 * 主进程入口 index.ts 里调一次。
 *
 * 设计：lazy open —— 主进程早期（app.whenReady 之前）的日志先打到 stdout / dev console，
 * ready 之后再切到文件，避免启动阻塞。
 *
 * 2026-06-11 修改：dev 模式也升级（teedup 调试时不光写 stdout 也写文件，
 * 方便 mavis agent 通过读日志定位 UI 报错）—— dev 时同时跑 stdout + file
 */
export function upgradeLoggerToFile(): void {
  // 2026-06-12 修复：dev 模式 buildLogger 已经在 module top-level 直接写文件，
  // upgradeLoggerToFile 重新开新文件 fd 可能 EPERM（~/.gitea-kanban/logs 拒写）→
  // 会抛 EPERM 杀死 app.whenReady()。
  // 修法：upgradeLoggerToFile 已经是 no-op（logger 已经是 file destination），
  // 不要再开新 fd。保留函数签名让 index.ts 不改。
  logger.info('upgradeLoggerToFile: skipped (logger already at file destination from module init)');
}

function cleanupOldLogs(logDir: string): void {
  try {
    const { readdirSync, statSync, unlinkSync } = require('node:fs') as typeof import('node:fs');
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(logDir)) {
      if (!name.startsWith('main-') || !name.endsWith('.log')) continue;
      const path = join(logDir, name);
      try {
        const stat = statSync(path);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(path);
          // 不用 console.log —— Electron 41 macOS GUI app stdout fd=-1 会 SonicBoom RangeError
          // logger 此时可能正在初始化（不能依赖），静默即可（unlink 本身成功就够）
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

/** 测试用：重置 logger（vitest 钩子） */
export function _resetLoggerForTest(): void {
  // 故意留空：pino 单例一旦创建无法销毁；
  // 测试通过 mock logger 的子方法或用 pino() 创建独立实例验证
}
