# M6 M2 polish 3: / 重定向 /board → /auth 对齐 spec

> **触发**：notes/m2-polish-followup.md §3
> **时间**：2026-06-13
> **结论**：✅ **PASS**

## 1. 改动

`src/renderer/routes/index.ts:21`

```diff
 const routes: RouteRecordRaw[] = [
   {
     path: '/',
-    redirect: '/board',
+    redirect: '/auth',
   },
```

- 注释第 6 行已写"根路径 / 重定向到 /auth（未连接时合理入口）"——**注释对了，实现错了**
- 本次只改实现，与注释对齐

## 2. 副作用评估

| 用户态 | 改动前 | 改动后 |
|---|---|---|
| 未连接 + 访问 / | 跳 /board → beforeEach 守卫跳 /auth | 跳 /auth（更直接） |
| 已连接 + 访问 / | 跳 /board（直接进） | 跳 /auth → beforeEach 守卫放行 → /board（**多一次重定向**） |

### 2.1 已连接用户多一次重定向的缓解（**不**在本任务）

```ts
// 方案 A：beforeEach 守卫中处理
router.beforeEach(async (to) => {
  if (to.path === '/') {
    const auth = useAuthStore();
    return auth.isConnected ? { name: 'board' } : { name: 'auth' };
  }
  // ... 其它守卫
});
```

方案 A 留 M6.1 polish，本任务**只**做 spec 对齐。

## 3. 验证

```
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
（EXIT 0，0 error）

$ pnpm check:no-jargon
[check:no-jargon] OK — 未发现禁用术语
（EXIT 0，0 命中）

$ git diff src/renderer/routes/index.ts
@@ -18,7 +18,7 @@ import { useAuthStore } from '@renderer/stores/auth';
 const routes: RouteRecordRaw[] = [
   {
     path: '/',
-    redirect: '/board',
+    redirect: '/auth',
（-1/+1 行，无其他变动）
```

## 4. 末行 VERDICT

**VERDICT: PASS**
