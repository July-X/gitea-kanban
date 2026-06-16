/**
 * TeamView 占位 · ADR-0004 落地验证（4 项断言）
 *
 * 拍板（2026-06-16 · ADR-0004）：v2 团队视图路由占位，v1 不进 store / IPC。
 * 这套断言锁死"占位 view 必须是零依赖 EmptyState"，防止未来被悄悄加业务逻辑。
 *
 * 为什么不渲染 SFC / 跑 vue-router：AGENTS §7.2 "当前 frontend 任务 0 装新依赖"
 * （happy-dom 不在 deps），且路由表顶层 import useAuthStore → 加载时 pinia init 需要
 * localStorage（node 环境没）。**纯静态**断言已经够证明 ADR-0004 落地。
 *
 * 这种"纯静态 + 文件指纹"断言**比渲染更稳**——文件没改、字符串没改、路由表没改，就
 * 100% 满足拍板。`pnpm test` 必跑、CI 必跑、未来回归立刻 fail。
 *
 * 运行：`pnpm test src/renderer/views/__tests__/TeamView.test.ts`
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 跑时 cwd = 项目根；__dirname = src/renderer/views/__tests__/
// 项目根 = 向上 4 层（tests/ → views/ → renderer/ → src/ → projectRoot）
const projectRoot = resolve(__dirname, '../../../..');
const teamViewPath = resolve(projectRoot, 'src/renderer/views/TeamView.vue');
const routesPath = resolve(projectRoot, 'src/renderer/routes/index.ts');
const navRailPath = resolve(projectRoot, 'src/renderer/components/NavRail.vue');

describe('ADR-0004 · /team 路由占位落地（4 项静态断言）', () => {
  describe('检查 1：TeamView.vue 文件 + EmptyState', () => {
    it('文件存在', () => {
      expect(existsSync(teamViewPath)).toBe(true);
    });

    it('使用 EmptyState 组件（v1 占位不允许业务内容）', () => {
      const content = readFileSync(teamViewPath, 'utf-8');
      expect(content).toContain('import EmptyState');
      // 模板里用了 <EmptyState ... />
      expect(content).toMatch(/<EmptyState\s/);
    });

    it('标题文案明示占位身份（v2 拍板后实现）', () => {
      const content = readFileSync(teamViewPath, 'utf-8');
      expect(content).toMatch(/v2 拍板后实现/);
    });
  });

  describe('检查 2：零 store / IPC / composable 依赖（v1 占位 view 必须零业务）', () => {
    it('不引任何 pinia store', () => {
      const content = readFileSync(teamViewPath, 'utf-8');
      const storeImport = content.match(/from\s+['"]@renderer\/stores\/[^'"]+['"]/);
      expect(storeImport).toBeNull();
      // 也不应该 useXxxStore() 调
      const useStoreCall = content.match(/use\w+Store\s*\(/);
      expect(useStoreCall).toBeNull();
    });

    it('不调任何 IPC（window.api / ipc-client）', () => {
      const content = readFileSync(teamViewPath, 'utf-8');
      expect(content).not.toMatch(/window\.api\./);
      expect(content).not.toMatch(/from\s+['"]@renderer\/lib\/ipc-client['"]/);
    });

    it('不调任何 composable（useBoardBootstrap / useBoardActions 等）', () => {
      const content = readFileSync(teamViewPath, 'utf-8');
      const composableImport = content.match(/from\s+['"]@renderer\/composables\/[^'"]+['"]/);
      expect(composableImport).toBeNull();
    });
  });

  describe('检查 3：路由表层（routes/index.ts）', () => {
    it("存在 /team 路由", () => {
      const content = readFileSync(routesPath, 'utf-8');
      expect(content).toMatch(/path:\s*['"]\/team['"]/);
    });

    it("路由 name 是 'team'（可被 router.push({ name: 'team' }) 调用）", () => {
      const content = readFileSync(routesPath, 'utf-8');
      expect(content).toMatch(/name:\s*['"]team['"]/);
    });

    it("路由 meta 标记 placeholder: 'v2'（明示 v2 候选身份）", () => {
      const content = readFileSync(routesPath, 'utf-8');
      expect(content).toMatch(/placeholder:\s*['"]v2['"]/);
    });

    it("路由 requiresAuth: true（跟其他业务路由一致）", () => {
      const content = readFileSync(routesPath, 'utf-8');
      // 抓 /team 段后 200 字符内必有 requiresAuth
      const teamBlock = content.match(/path:\s*['"]\/team['"][\s\S]{0,400}/);
      expect(teamBlock).not.toBeNull();
      expect(teamBlock![0]).toMatch(/requiresAuth:\s*true/);
    });

    it('/team 路由排在 wildcard 之前（不会被 fallback 吞掉）', () => {
      const content = readFileSync(routesPath, 'utf-8');
      const teamIdx = content.search(/path:\s*['"]\/team['"]/);
      const wildcardIdx = content.search(/path:\s*['"]\/:pathMatch/);
      expect(teamIdx).toBeGreaterThan(-1);
      expect(wildcardIdx).toBeGreaterThan(-1);
      expect(teamIdx).toBeLessThan(wildcardIdx);
    });
  });

  describe('检查 4：NavRail 不挂 /team 入口（v2 拍板前不暴露）', () => {
    it('NavRail 不引 "team" 路由名（无 router.push 引用）', () => {
      const content = readFileSync(navRailPath, 'utf-8');
      // NavRail 不应该出现 "team" 字面量
      expect(content).not.toMatch(/['"]team['"]/);
    });
  });
});
