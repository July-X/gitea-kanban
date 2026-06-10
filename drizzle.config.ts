// drizzle-kit 迁移配置
// 13 张表的 schema 在 src/main/cache/schema/*.ts
// 迁移产物生成到 drizzle/ 目录
// 应用启动时由 src/main/cache/migrator.ts 顺序执行
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/main/cache/schema/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // 仅供 drizzle-kit studio / generate 用；运行时迁移走 src/main/cache/sqlite.ts
    // 不连真实库（避免和 userData 路径耦合）
    url: ':memory:',
  },
  verbose: true,
  strict: true,
});
