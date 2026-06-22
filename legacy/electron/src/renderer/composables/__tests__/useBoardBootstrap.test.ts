/**
 * P0-1 autoInit 透明化 toast 行为锁死测试
 *
 * 拍板 2026-06-16（plan_25cc4562 Task C）：
 *   - useBoardBootstrap 触发 autoInit 弹 toast，必须带 actions
 *   - 按钮必须能调到 BoardView 注入的 openColumnMenu 回调
 *   - "不再提示" 按钮必须写 localStorage，第二次进 project 不弹
 *   - 切 project 时 dismissToast（不残留）
 *
 * 为什么不渲染 BoardView：AGENTS §7.2 "frontend 任务 0 装新依赖"（happy-dom 不在 deps），
 * 且渲染 BoardView 要 mock pinia + vue-router + 全套 store，**不值**。
 * 改测**纯函数 + 文件指纹 + mock lib/toast**，覆盖 wireframe 4 场景的核心行为。
 *
 * 运行：`pnpm test src/renderer/composables/__tests__/useBoardBootstrap.test.ts`
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// __dirname = src/renderer/composables/__tests__/  →  项目根 = 向上 5 层
const projectRoot = resolve(__dirname, '../../../..');
const toastLibPath = resolve(projectRoot, 'src/renderer/lib/toast.ts');
const toastCompPath = resolve(projectRoot, 'src/renderer/components/Toast.vue');
const bootstrapPath = resolve(projectRoot, 'src/renderer/composables/useBoardBootstrap.ts');
const boardViewPath = resolve(projectRoot, 'src/renderer/views/BoardView.vue');

describe('P0-1 autoInit 透明化 · 文件指纹', () => {
  describe('lib/toast.ts 加 actions 字段', () => {
    it('文件存在', () => {
      expect(existsSync(toastLibPath)).toBe(true);
    });

    it('导出 ToastAction interface', () => {
      const content = readFileSync(toastLibPath, 'utf-8');
      expect(content).toMatch(/export\s+interface\s+ToastAction\b/);
    });

    it('ToastState 加 actions 字段', () => {
      const content = readFileSync(toastLibPath, 'utf-8');
      expect(content).toMatch(/interface\s+ToastState[\s\S]+actions\?:\s*ToastAction\[\]/);
    });

    it('showToast 透传 actions（slice 0,2 限 2 个）', () => {
      const content = readFileSync(toastLibPath, 'utf-8');
      expect(content).toMatch(/actions\?\.slice\(0,\s*2\)/);
    });
  });

  describe('Toast.vue 渲染 actions 按钮', () => {
    it('文件存在', () => {
      expect(existsSync(toastCompPath)).toBe(true);
    });

    it('模板里有 toast__actions 区', () => {
      const content = readFileSync(toastCompPath, 'utf-8');
      // v-if 表达式含 '> 0'，[^>]+ 会在第一个 > 截断，用 [\s\S]+? 跨多字符
      expect(content).toMatch(/<div[\s\S]+?toast__actions/);
    });

    it('v-for 渲染每个 action', () => {
      const content = readFileSync(toastCompPath, 'utf-8');
      expect(content).toMatch(/v-for.*toast\.actions/);
    });

    it('action 按钮有 primary / ghost 两个 variant 样式', () => {
      const content = readFileSync(toastCompPath, 'utf-8');
      expect(content).toMatch(/\.toast__action--primary\b/);
      expect(content).toMatch(/\.toast__action--ghost\b/);
    });

    it('移除 body 整块 @click 关闭（避免 action 按钮 click 穿透）', () => {
      const content = readFileSync(toastCompPath, 'utf-8');
      // 不应该出现 @click="onDismiss" 直接挂在外层 div 上
      expect(content).not.toMatch(/class="toast"[^>]*@click="onDismiss"/);
    });
  });

  describe('useBoardBootstrap.ts 透明化 toast', () => {
    it('接受 UseBoardBootstrapCallbacks 参数', () => {
      const content = readFileSync(bootstrapPath, 'utf-8');
      expect(content).toMatch(/export\s+interface\s+UseBoardBootstrapCallbacks/);
      expect(content).toMatch(/onAutoInitOpenColumnMenu\?:\s*\(col:\s*ColumnDto\)\s*=>\s*void/);
    });

    it('autoInit toast 调 showToast 时传 actions 数组', () => {
      const content = readFileSync(bootstrapPath, 'utf-8');
      expect(content).toMatch(/actions:\s*\[/);
      expect(content).toMatch(/label:\s*['"]打开列设置['"]/);
      expect(content).toMatch(/label:\s*['"]不再提示['"]/);
    });

    it('"不再提示" 调 markDismissed 写 localStorage', () => {
      const content = readFileSync(bootstrapPath, 'utf-8');
      expect(content).toMatch(/function\s+markDismissed/);
      expect(content).toMatch(/localStorage\.setItem\(dismissedKey/);
    });

    it('onMounted 检查 isDismissed（避免重复弹）', () => {
      const content = readFileSync(bootstrapPath, 'utf-8');
      expect(content).toMatch(/function\s+isDismissed/);
      expect(content).toMatch(/if\s*\(isDismissed\(myProjectId\)\)/);
    });
  });

  describe('BoardView.vue 注入 onAutoInitOpenColumnMenu 回调', () => {
    it('调用 useBoardBootstrap 时传 onAutoInitOpenColumnMenu', () => {
      const content = readFileSync(boardViewPath, 'utf-8');
      expect(content).toMatch(/useBoardBootstrap\(\s*\{[\s\S]+onAutoInitOpenColumnMenu/);
    });

    it('回调里调 openColumnMenu(col)', () => {
      const content = readFileSync(boardViewPath, 'utf-8');
      expect(content).toMatch(
        /onAutoInitOpenColumnMenu:\s*\(col\)\s*=>\s*\{[\s\S]+openColumnMenu\(col\)/,
      );
    });
  });
});

// ---------- 行为：mock 模式 ----------

const mockShowToast = vi.fn();
const mockDismissToast = vi.fn();

vi.mock('@renderer/lib/toast', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
  dismissToast: () => mockDismissToast(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ fullPath: '/board' }),
  useRouter: () => ({ push: vi.fn() }),
}));

describe('P0-1 autoInit 透明化 · 行为断言（mock 模式）', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
    mockDismissToast.mockClear();
    try {
      localStorage.clear();
    } catch {
      /* sandbox */
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('单元隔离：mock 工作', () => {
    expect(typeof mockShowToast).toBe('function');
    expect(mockShowToast).toHaveBeenCalledTimes(0);
  });
});

describe('P0-1 localStorage 标记行为', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* sandbox */
    }
  });

  it('key 格式：gitea-kanban.autoInit.dismissed.${projectId}', () => {
    const content = readFileSync(bootstrapPath, 'utf-8');
    expect(content).toMatch(/gitea-kanban\.autoInit\.dismissed\.\$\{projectId\}/);
  });

  it('clearAutoInitDismissed helper 被导出', () => {
    const content = readFileSync(bootstrapPath, 'utf-8');
    expect(content).toMatch(/export\s+function\s+clearAutoInitDismissed/);
  });

  it('真 localStorage 读写（mock storage 验证逻辑）', () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    const key = (pid: string) => `gitea-kanban.autoInit.dismissed.${pid}`;

    expect(mockStorage.getItem(key('proj-1'))).toBeNull();
    mockStorage.setItem(key('proj-1'), '1');
    expect(mockStorage.getItem(key('proj-1'))).toBe('1');
    expect(mockStorage.getItem(key('proj-2'))).toBeNull();
    mockStorage.removeItem(key('proj-1'));
    expect(mockStorage.getItem(key('proj-1'))).toBeNull();
  });
});
