// W3 e2e runner wrapper：注册 electron ESM resolver hook 后跑目标脚本
//
// 用法：node scripts/_e2e-runner.mjs scripts/e2e-verify-w3.ts
//
// 方案：通过 NODE_OPTIONS=--import=<loader> 在子进程启动前注入 resolver hook
//  - 主进程 register() 不会被子进程继承
//  - 但 NODE_OPTIONS=--import=... 在子进程启动期就被 node runtime 处理
//  - 所以我们在 spawn 时透传 NODE_OPTIONS 给子进程（注意**不**覆盖用户已设的）

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/_e2e-runner.mjs <script-path> [args...]');
  process.exit(1);
}

// 注入我们的 ESM resolver（用 --import 让 node runtime 在子进程启动时 load）
// --import=file:///abs/path/to/_e2e-loader.mjs
// _e2e-loader.mjs 在其模块顶层 register() resolver hook
const loaderPath = path.join(__dirname, '_e2e-loader.mjs');
const importArg = `--import=file://${loaderPath}`;

const existingNodeOptions = process.env['NODE_OPTIONS'] ?? '';
const newNodeOptions = existingNodeOptions
  ? `${existingNodeOptions} ${importArg}`
  : importArg;

const proc = spawn(
  'npx',
  ['tsx', target, ...process.argv.slice(3)],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: newNodeOptions,
    },
  },
);
proc.on('exit', (code) => process.exit(code ?? 0));
