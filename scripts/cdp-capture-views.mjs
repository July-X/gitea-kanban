#!/usr/bin/env node
/**
 * C-2 设计走查 view 截图采集脚本
 *
 * 用途：自动采集 7 view × 3 尺寸 = 21 张 baseline 截图，供设计师走查对比 OVERRIDE.md。
 *
 * 前置：
 *   1. 启动 demo gitea（docker compose up -d）+ reset demo 数据
 *   2. 启动 dev app：`pnpm dev`（或 `pnpm build` + 起 out/.../gitea-kanban）
 *   3. 等 app 启动完成后，dev app 默认会监听 CDP 端口 9492
 *
 * 用法：
 *   node scripts/cdp-capture-views.mjs           # 默认：7 view × 3 尺寸
 *   node scripts/cdp-capture-views.mjs --view board --size 1280  # 单 view 单尺寸
 *   node scripts/cdp-capture-views.mjs --port 9493               # 自定义 CDP 端口
 *
 * 输出：
 *   notes/screenshots/c2-{view}-{size}.png
 *
 * 截图清单：
 *   AuthView / BoardView / MyCardsView / TimelineView / MergesView / MembersView / SettingsView
 *   尺寸：default (1280×800) / narrow (1024×720) / min (960×600)
 */

import { get } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'notes', 'screenshots');

// ===== CLI 参数 =====
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i += 2) {
  argMap[args[i].replace(/^--/, '')] = args[i + 1];
}
const CDP_PORT = argMap.port ?? '9492';
const SINGLE_VIEW = argMap.view;
const SINGLE_SIZE = argMap.size;

// ===== 7 view 清单 =====
// 每个 view 配：vue-router 路径、侧边栏点击目标 selector（按钮文字）
const VIEWS = [
  { name: 'auth', title: '登录', path: '/auth', sidebar: null, loadWait: 1000 },
  { name: 'board', title: '看板', path: '/board', sidebar: '看板', loadWait: 2000 },
  { name: 'my-cards', title: '我的卡片', path: '/my-cards', sidebar: '我的卡片', loadWait: 1500 },
  { name: 'timeline', title: '时间轴', path: '/timeline', sidebar: '时间轴', loadWait: 3000 },
  { name: 'merges', title: '合并请求', path: '/merges', sidebar: '合并请求', loadWait: 2500 },
  { name: 'members', title: '成员', path: '/members', sidebar: '成员', loadWait: 1500 },
  { name: 'settings', title: '设置', path: '/settings', sidebar: '设置', loadWait: 1000 },
];

// ===== 3 尺寸 =====
const SIZES = [
  { name: 'default', w: 1280, h: 800 },
  { name: 'narrow', w: 1024, h: 720 },
  { name: 'min', w: 960, h: 600 },
];

// ===== CDP client =====
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
}

// ===== 主流程 =====
async function main() {
  console.log(`[c2-capture-views] CDP port = ${CDP_PORT}`);
  await mkdir(OUT_DIR, { recursive: true });

  // 1. 列出所有 devtools targets
  const pages = await new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const targets = pages.filter((p) => p.type === 'page');
  if (targets.length === 0) {
    throw new Error(`No page targets found on CDP port ${CDP_PORT}. Is the dev app running?`);
  }
  // 默认选第一个 page（renderer 主窗口）
  const target = targets[0];
  console.log(`[c2-capture-views] target: ${target.title} (${target.url})`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('ws timeout')), 10_000);
  });
  const cdp = new CdpClient(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 2. 决定本次跑哪些 view × size
  const views = SINGLE_VIEW ? VIEWS.filter((v) => v.name === SINGLE_VIEW) : VIEWS;
  if (views.length === 0) {
    throw new Error(`View "${SINGLE_VIEW}" not found. Available: ${VIEWS.map((v) => v.name).join(', ')}`);
  }
  const sizes = SINGLE_SIZE ? SIZES.filter((s) => s.name === SINGLE_SIZE) : SIZES;
  if (sizes.length === 0) {
    throw new Error(`Size "${SINGLE_SIZE}" not found. Available: ${SIZES.map((s) => s.name).join(', ')}`);
  }

  // 3. 遍历截图
  const total = views.length * sizes.length;
  let done = 0;
  let failCount = 0;

  for (const view of views) {
    for (const size of sizes) {
      done += 1;
      const filename = `c2-${view.name}-${size.name}.png`;
      const outPath = join(OUT_DIR, filename);

      try {
        console.log(`[${done}/${total}] ${view.name} @ ${size.name} (${size.w}×${size.h})...`);

        // 3.1 设置窗口尺寸
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: size.w,
          height: size.h,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // 3.2 导航到目标 view
        const navExpr = view.path === '/auth'
          ? `(async () => { window.location.hash = '#${view.path}'; })()`
          : `(async () => {
              // 通过 vue-router 跳转（如果可用）
              if (window.$nuxt?.$router) window.$nuxt.$router.push('${view.path}');
              else if (window.__appRouter) window.__appRouter.push('${view.path}');
              else window.location.hash = '#${view.path}';
              // 等待 view 加载
              await new Promise(r => setTimeout(r, ${view.loadWait}));
              return location.hash;
            })()`;
        await cdp.send('Runtime.evaluate', { expression: navExpr, awaitPromise: true });

        // 3.3 截屏
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(outPath, Buffer.from(shot.data, 'base64'));
        console.log(`  ✓ saved ${outPath}`);
      } catch (err) {
        failCount += 1;
        console.error(`  ✗ FAILED ${view.name} @ ${size.name}: ${err.message}`);
      }
    }
  }

  // 4. 复位（避免影响后续操作）
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  ws.close();

  console.log(`\n[c2-capture-views] Done. ${done - failCount}/${total} succeeded, ${failCount} failed.`);
  console.log(`Output dir: ${OUT_DIR}`);

  // 5. 输出清单（供设计师走查用）
  console.log('\n=== 截图清单 ===');
  for (const view of views) {
    for (const size of sizes) {
      const filename = `c2-${view.name}-${size.name}.png`;
      console.log(`  ${filename}`);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[c2-capture-views] FATAL: ${err.message}`);
  process.exit(2);
});