#!/usr/bin/env tsx
/**
 * 零术语检查脚本
 *
 * 检查 src/renderer/ 下任何 .ts/.tsx/.html/.md 文件**不**含禁用术语原词
 *
 * 禁用术语（AGENTS.md §8.3 / 02-architecture.md §2.7 / design-system OVERRIDE）：
 *   PR | merge | rebase | fork | repo | branch | maintainer | issue（保留）
 *   实际翻译表见 design-system/gitea-kanban/OVERRIDE.md §本项目专属规则 #1
 *
 * v1：先做 MVP——只检查 renderer 下文件
 * M1 补全：检查 commit message / 文档 / wireframe
 *
 * 用法：
 *   pnpm check:no-jargon
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const FORBIDDEN_TERMS = [
  // 严格匹配：\b 边界
  { term: 'PR', desc: '合并请求的英文缩写', except: [] },
  { term: 'merge', desc: '合并', except: ['mergeMethod'] },  // 字段名除外
  { term: 'rebase', desc: '变基', except: [] },
  { term: 'fork', desc: '派生（v2 考虑）', except: [] },
  { term: 'repo', desc: '仓库', except: ['repository', 'repos'] },  // repos 是 endpoint namespace
  { term: 'branch', desc: '分支', except: [] },
  { term: 'maintainer', desc: '维护者', except: [] },
];

const SCAN_DIRS = ['src/renderer'];
const SCAN_EXTS = ['.ts', '.tsx', '.html', '.md'];
const SKIP_DIRS = ['node_modules', 'out', 'dist', 'coverage', '.d.ts'];

interface Hit {
  file: string;
  line: number;
  term: string;
  context: string;
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.includes(name);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (shouldSkipDir(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTS.includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function check(): Hit[] {
  const hits: Hit[] = [];
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { term, except } of FORBIDDEN_TERMS) {
        // 单词边界
        const re = new RegExp(`\\b${term}\\b`, 'g');
        const matches = line.match(re);
        if (!matches) continue;
        // 排除白名单
        if (except.some((e) => line.includes(e))) continue;
        for (let _mi = 0; _mi < matches.length; _mi++) {
          hits.push({
            file,
            line: i + 1,
            term,
            context: line.trim().slice(0, 80),
          });
        }
      }
    }
  }
  return hits;
}

const hits = check();
if (hits.length === 0) {
  console.log('[check:no-jargon] OK — 未发现禁用术语');
  process.exit(0);
}

console.error('[check:no-jargon] FAIL — 发现禁用术语：');
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  命中 "${h.term}"`);
  console.error(`    > ${h.context}`);
}
console.error(`\n共 ${hits.length} 处命中。请走翻译表（见 design-system/gitea-kanban/OVERRIDE.md §本项目专属规则 #1）`);
process.exit(1);
