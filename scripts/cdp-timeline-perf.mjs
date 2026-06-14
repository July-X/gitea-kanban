#!/usr/bin/env node
/**
 * CDP 性能探测脚本：连到 Electron remote debugging port (9492)
 * 在时间轴页面点击多个分支，记录关键指标。
 */
import { get } from 'node:http';

const CDP_HTTP = 'http://127.0.0.1:9492';
const TIMEOUT_MS = 60_000;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}\n${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.onEvent = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (this.onEvent) this.onEvent(msg);
      }
    };
  }
  async send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    send(this.ws, { id, method, params });
    return p;
  }
  close() {
    this.ws.close();
  }
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const pages = await httpGetJson(`${CDP_HTTP}/json/list`);
  const target = pages.find((p) => p.title.includes('时间轴') && p.type === 'page');
  if (!target) {
    console.error('Available pages:', pages.map((p) => `${p.type}: ${p.title}`).join('\n'));
    throw new Error('Timeline page not found');
  }
  console.log('Attach to', target.id, target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('websocket timeout')), 10_000);
  });

  const cdp = new CdpClient(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Performance.enable');
  await cdp.send('DOM.enable');

  // 注入性能测量 helper：点击分支 + PerformanceObserver(longtask) + 关键 computed 耗时
  const measureScript = `
    (async () => {
      const chips = Array.from(document.querySelectorAll('.branch-chip'));
      const result = {
        branchCount: chips.length,
        selectedSequence: [],
        longTasks: [],
        marks: [],
        errors: []
      };

      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          result.longTasks.push({
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            name: entry.name,
            attribution: entry.attribution?.map(a => a.containerName || a.containerType || 'script')
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });

      function mark(name) {
        performance.mark(name);
        result.marks.push({ name, time: Math.round(performance.now()) });
      }

      function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
      }

      async function clickChip(label) {
        const chip = chips.find(c => c.textContent.trim() === label);
        if (!chip) { result.errors.push('chip not found: ' + label); return; }
        mark('before-click-' + label);
        chip.click();
        // 等待 Vue 下一轮更新 + 至少 500ms 让 longtask 落袋
        await sleep(600);
        mark('after-click-' + label);
      }

      // 顺序点击前 6 个分支 chip（如果少于 6 个则全部点）
      const toClick = chips.slice(0, 6).map(c => c.textContent.trim());
      for (const label of toClick) {
        await clickChip(label);
        result.selectedSequence.push(label);
      }

      observer.disconnect();
      return result;
    })()
  `;

  console.log('Start clicking branches...');
  const evalStart = Date.now();
  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: measureScript,
    awaitPromise: true,
    returnByValue: true,
    timeout: TIMEOUT_MS,
  });
  const evalElapsed = Date.now() - evalStart;
  console.log('Evaluation elapsed (ms):', evalElapsed);

  if (evalRes.exceptionDetails) {
    console.error('Script exception:', evalRes.exceptionDetails);
  } else {
    console.log('Result:', JSON.stringify(evalRes.result.value, null, 2));
  }

  // 拿 Performance.getMetrics
  const metrics = await cdp.send('Performance.getMetrics');
  console.log('Performance metrics:', JSON.stringify(metrics, null, 2));

  cdp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
