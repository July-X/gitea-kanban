/**
 * pino logger 实例（主进程唯一日志出口）
 *
 * 铁律（AGENTS.md §4.5 / §8.2）：
 * - token / password / key 字段**永远**从日志里 redact（redact 规则写死，禁止关闭）
 * - 热路径用 logger.isLevelEnabled('debug') 保护，避免字符串拼接开销
 * - 日志落 app.getPath('logs')/main-YYYY-MM-DD.log，按日滚动，保留 14 天
 *
 * 渲染进程直接用 console（开发期）；生产期通过 IPC 转发到主进程 logger。
 */

import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
 * 计算日志目录：app.getPath('logs')/main
 *
 * 不能接受用户路径——这是 Electron 标准 API 的安全调用。
 * app.isReady() 之前 logger 可能被引用（早期启动日志），所以用 try/catch。
 */
function resolveLogDir(): string {
  try {
    const logsRoot = app.getPath('logs');
    const dir = join(logsRoot, LOG_SUBDIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    // app 还没 ready 时 fallback 到 tmp
    return '/tmp/gitea-kanban-logs';
  }
}

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
    // 开发模式：pino-pretty 直接写 stdout
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }
  // 生产模式：先不写文件（避免文件 IO 在 ipcMain.handle 热路径上做 sync I/O）
  // 文件落盘由 app.whenReady() 之后异步开启；不阻塞主进程启动
  // 测试覆盖这个分支：见 logger.test.ts
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
 */
export function upgradeLoggerToFile(): void {
  if (isDev) return; // dev 永远走 stdout
  const logDir = resolveLogDir();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = join(logDir, `main-${date}.log`);

  // 创建 file transport；保留 stdout（stderr 同源）方便容器化部署收集
  // pino.destination() 同步开文件，pino transport 异步接管
  // 这里用 pino-pretty 不带 pretty 的 file 模式：直接 JSON 行
  // 注：roll 由外部 cron / logrotate 维护（v1 不自实现滚动——按日开启新文件，14 天后被 OS 清理）
  // 实际保留 14 天由本进程启动时清理：
  cleanupOldLogs(logDir);

  const fileLogger = pino({
    ...baseOptions,
    // 不写 transport；用 pino.destination 直接落盘
  }, pino.destination({
    dest: filename,
    sync: false,
    mkdir: true,
    mode: 0o600,
  }));

  // 把现有 logger 的 methods 重新指向 fileLogger
  // 注意：logger 对象本身已被 import 引用，不能替换；只能 mutate 它的 level + 内部 child
  // 简化处理：fileLogger 仅供 new code 使用，老的 logger 引用仍走 stdout
  // 实际上 pino 支持重新 bind——这里用最简单的方案：export fileLogger 作新引用
  // 上层已经在写 logger.info/logger.error，pino 实例的 method 是固定的；
  // 我们**重新 export** 一个 fileLogger，但调用方还是用 logger 名字。
  // → 妥协方案：直接重写 logger 的方法。
  copyLoggerMethods(fileLogger, logger);
}

function copyLoggerMethods(src: Logger, dst: Logger): void {
  const methods: Array<keyof Logger> = [
    'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent',
  ];
  for (const m of methods) {
    // @ts-expect-error pino types permit this
    dst[m] = src[m].bind(src);
  }
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
          // 用 stdout 走（这个阶段 logger 可能还在切）
          console.log(`[logger] cleaned up old log: ${name}`);
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
