#!/usr/bin/env tsx
/**
 * 零术语检查脚本
 *
 * 检查 src/renderer/ 下任何 .ts/.tsx/.html/.md/.vue 文件**不**含禁用术语原词
 *
 * 禁用术语（AGENTS.md §8.3 / 02-architecture.md §2.7 / design-system OVERRIDE）：
 *   PR | merge | rebase | fork | repo | branch | maintainer | issue（保留）
 *   实际翻译表见 design-system/gitea-kanban/OVERRIDE.md §本项目专属规则 #1
 *
 * v1：先做 MVP——只检查 renderer 下文件
 * M1 补全：检查 commit message / 文档 / wireframe
 * v1.1.3 polish：加 .vue SFC 整文件扫（之前 SCAN_EXTS 不含 .vue → 渲染层 UI 文本 0 防护）
 *
 * .vue 扫描范围：整 SFC（template + script + style 都过一遍）
 *   - template：按钮 / placeholder / aria-label / title → 用户可见
 *   - script：showToast({ message: '已创建议题' }) / i18n 字符串 → 用户可见
 *   - style：CSS class（branch-chip 等）→ 已被 except 白名单覆盖，零误报
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
  { term: 'PR', desc: '合并请求的英文缩写', except: ['不出现', '禁用词', '零术语', '**不**出现', 'UI 文本'] },  // 注释禁用词复述
  { term: 'merge', desc: '合并', except: ['mergeMethod', 'merge-', "'merge'", 'isMerge', 'edge.kind', 'commit-node--', '不出现', '禁用词', '零术语', '**不**出现', 'merge 边', 'UI 文本'] },  // 字段名 / BEM / edge kind 字面量 / 运行时引用 / 注释禁用词复述
  { term: 'rebase', desc: '变基', except: ['不出现', '禁用词', '零术语', '**不**出现', 'UI 文本'] },
  { term: 'fork', desc: '派生（v2 考虑）', except: ['不出现', '禁用词', '零术语', '**不**出现', 'UI 文本'] },
  // repo: 除了"repos"是 endpoint namespace 外,渲染端代码里还有合法的
  // 类型名 / 变量名 / IPC schema 字段名('owner'/'repo'/'refId' 三元组 / RepoDto 等)、
  // Pinia store method 调用（repo.xxx() / repo.value / repo.xx.yy）、
  // BEM class（statusbar__repo / statusbar__repo-name）、
  // activeRepo / owner / repo 三元组注释。
  // 这些都是"代码内合法英文术语",不是 UI 文本。
  {
    term: 'repo',
    desc: '仓库',
    except: [
      'repository',
      'repos',          // endpoint namespace
      'RepoDto',        // 类型名
      'RepoProject',    // 类型名
      'useRepoStore',   // pinia store id
      'repos.',
      'repo.',          // Pinia store method 调用（repo.loadRepos / repo.currentRepo 等）
      'repo:',          // IPC schema 字段名(owner/repo/refId 三元组)
      'repo ',          // 标识符后空格
      'repo)',          // 函数调用
      'repo(',
      "'repo",          // pinia defineStore id 字面量
      '__repo',         // BEM class 后缀（statusbar__repo / statusbar__repo-name）
      'activeRepo',     // 变量名
      '不出现',         // 注释禁用词复述
      '禁用词',
      '零术语',
      '<owner>/<repo>', // 注释 / 文档 URL 模板
    ],
  },
  // branch: 渲染端代码里有 IPC schema LaneModeSchema 字面量('branch')、
  // 类型名(BranchDto/BranchRef/BranchLastCommit)、字段名(branchHints)、
  // 变量名(branches.value/selectedBranches/defaultBranch)、CSS class。
  // .vue 落地后又有 BEM class(branch-item / branch-commit-row)、
  // HTML data 属性(data-branch-name)、CSS BEM 后缀(.branch-chip)、
  // import path（@renderer/stores/branch）、URL path（src/branch/{name}）、
  // 注释描述（branch lane）。
  // 这些都是"代码内合法英文术语",不是 UI 文本。
  {
    term: 'branch',
    desc: '分支',
    except: [
      'BranchDto',
      'BranchRef',
      'BranchLastCommit',
      'branchHints',
      'branchDto',     // 变量名驼峰
      'branches',      // 复数(branches.value 等)+ IPC channel
      'BranchesList',  // 函数名
      'branchesList',
      'selectedBranches',
      'defaultBranch',
      'useBranchStore',
      'stores/branch', // import path
      'src/branch',    // gitea URL path（src/branch/{name}）
      'branch-chip',   // CSS class
      'branch-item',   // BEM class
      'branch-commit-row',
      'data-branch-',  // HTML data 属性
      'data-commit-sha', // v1.3 commit 行 data 属性
      'isBranch',
      'branchName',
      'branch lane',   // 注释描述（X6 graph 多泳道）
      'timeline__branches',
      "'branch",       // LaneModeSchema 字面量
      "'Branch",
      'branch:',
      'branch.',       // 变量名前缀
      'branch)',
      'branch(',
      'branch ',
      'next.branch',   // v1.3 route query 对象 delete 字段
      'query.branch',  // v1.3 route.query.branch 字段读取
      '不出现',        // 注释禁用词复述
      '禁用词',
      '零术语',
    ],
  },
  { term: 'maintainer', desc: '维护者', except: ['不出现', '禁用词', '零术语', '**不**出现', 'UI 文本'] },
];

const SCAN_DIRS = ['src/renderer'];
// .vue SFC 整文件扫（不只抽 <template>）：
// - <template> 里的中文按钮 / placeholder / aria-label / title
// - <script> 里的 toast message 字面 / i18n 字符串
// - <style> 里的 CSS class（branch-chip / timeline__branches 等）已被 except 白名单覆盖
// 跟 .ts 一样走同一套单词边界 + 白名单规则。
const SCAN_EXTS = ['.ts', '.tsx', '.html', '.md', '.vue'];
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
