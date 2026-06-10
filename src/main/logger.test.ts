/**
 * logger 单测
 *
 * 关键约束（AGENTS.md §4.5 / §8.2）：
 * - redact 规则含 *.token / *.password / token / password 等
 * - 写日志时这些字段被 [REDACTED] 替换
 *
 * 测：用 pino 自己的 write target 捕获输出，验证 redact 生效
 */

import { describe, it, expect } from 'vitest';
import { pino, type Logger } from 'pino';
import { Writable } from 'node:stream';

function captureLogger(redactPaths: string[]): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    {
      level: 'info',
      redact: { paths: redactPaths, censor: '[REDACTED]' },
      timestamp: false,
    },
    stream,
  );
  return { logger, lines };
}

describe('pino redact 规则（AGENTS.md §4.5 铁律）', () => {
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
  ];

  it('顶层 token 被 redact', () => {
    const { logger, lines } = captureLogger(REDACT_PATHS);
    logger.info({ token: 'ghp_secret' }, 'login');
    const out = JSON.parse(lines[0]!);
    expect(out.token).toBe('[REDACTED]');
    expect(out.msg).toBe('login');
  });

  it('嵌套 token 被 redact（*.token）', () => {
    const { logger, lines } = captureLogger(REDACT_PATHS);
    logger.info({ req: { token: 'ghp_secret' } }, 'call');
    const out = JSON.parse(lines[0]!);
    expect(out.req.token).toBe('[REDACTED]');
  });

  it('password / apiKey / secret 都被 redact', () => {
    const { logger, lines } = captureLogger(REDACT_PATHS);
    logger.info(
      {
        password: 'p',
        apiKey: 'k',
        secret: 's',
        nested: { key: 'k' },
      },
      'creds',
    );
    const out = JSON.parse(lines[0]!);
    expect(out.password).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.nested.key).toBe('[REDACTED]');
  });

  it('Authorization header 被 redact', () => {
    const { logger, lines } = captureLogger(REDACT_PATHS);
    logger.info(
      { req: { headers: { authorization: 'token ghp_secret' } } },
      'http',
    );
    const out = JSON.parse(lines[0]!);
    expect(out.req.headers.authorization).toBe('[REDACTED]');
  });

  it('非敏感字段不 redact', () => {
    const { logger, lines } = captureLogger(REDACT_PATHS);
    logger.info(
      { user: 'alice', giteaUrl: 'http://x', projectId: 'p1' },
      'ok',
    );
    const out = JSON.parse(lines[0]!);
    expect(out.user).toBe('alice');
    expect(out.giteaUrl).toBe('http://x');
  });
});
