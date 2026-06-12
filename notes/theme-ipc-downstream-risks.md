# theme-ipc — 下游边界风险（backend 自查 · 2026-06-12）

> theme-ipc task PASS 后，backend worker 主动盘的下游联动风险。
> 给 theme-preload / theme-store / theme-statusbar / theme-settings / theme-command 5 个 frontend task 接手时必读。
> 跟 verifier §5/§16 SSOT 拍板 + tech-refine.md §14-§16 一一对应。

---

## backend 已保证（静态 grep 可见）

| # | 风险点 | backend 实际状态 |
|---|---|---|
| 1 | IPC 契约 solid | get 返 `{theme, changedAt}` / set 返 `{theme, changedAt}` / 4 个 IpcErrorCode（DATABASE_UNAVAILABLE / THEME_NOT_FOUND + set 专属 INVALID_THEME / DATABASE_WRITE_FAILED）|
| 2 | Round-trip 一致 | `set('C-dark') → get()` 必返 `{theme: 'C-dark', changedAt: <set 的 now>}` — setTheme:264-265 + getTheme:188-191 实现锁 |
| 3 | WAL 同步无 race | better-sqlite3 WAL → get 在 set 后立即调必看到最新值 |

---

## verifier 静态层容易漏的边界（frontend 自查）

### #4 3 入口 → 同一 store（**核心风险**）

- StatusBar cycle / Settings 外观 / 命令面板 ⌘K 必须经**同一个 Pinia store**（建议建 `src/renderer/stores/ui.ts` 的 `currentTheme` + `applyTheme`）
- **不**能各自管 state —— 否则 StatusBar 切了 Settings 仍显旧值
- 防御：grep 验证 3 个 entry component 都 import 同一 store action（如 `useUiStore().setTheme()`）

### #5 set 失败回滚（**核心风险**）

- DATABASE_WRITE_FAILED 时 store **不**调 `applyTheme`（用户感知无变化）—— tech-refine §15.2 拍板
- 如果 frontend 只 `await invoke()` 不查 `err.code`，UI 切了但 sqlite 没写 → 下次启动 revert → 用户困惑
- 防御模板：

```ts
const result = await window.api.preferences.theme.set({ theme: next })
if (!isIpcError(result)) {
  // 成功才 apply
  store.applyTheme(result.theme)
} else if (result.code === 'DATABASE_WRITE_FAILED') {
  // 显式 revert + toast
  toast.error('主题保存失败，请重试')
  return // 不调 applyTheme
}
```

### #6 localStorage 缓存层（**hydration 必读**）

- 启动期 main 读 sqlite 异步 50-200ms，renderer 从 localStorage 同步读 0ms —— 谁写 localStorage？
- preload 桥还是 store？**backend 不应做这层**（写 localStorage 跨端不一致）
- 推荐：store 在 `set` 成功回包后**自己**写 `localStorage.setItem('theme', theme)` —— 启动期 store 初始化同步读 localStorage 兜底（避免 hydration 闪一下）
- 防御：
  - localStorage 写入只走 store（不在 3 个 entry 各自写）
  - 启动期 hydration fallback 路径要测（删 sqlite prefs row → 看 localStorage 仍能恢复）

### #7 Cycle 顺序未拍板（frontend self-decide）

- tech-refine §15.1 只说"点按钮在 A 暗 / C 暗 / Light 之间循环"，**没指定**循环顺序
- A→C→L→A 还是 A→L→C→A？frontend 自决，backend 不卡
- 推荐理由：
  - A→C→L：相邻色温递进（C 暗比 A 暗对比更强，亮 Light 最跳变；"越按越亮"心智）
  - A→L→C：按使用频度递增（默认 A 暗，下一个是 Light → C 暗高级感）
- backend 倾向 A→C→L（与"渐进亮度"心智一致），frontend 自由选择

---

## 已发现的现有问题（非 backend 引入）

### #8 src/renderer/index.html:2 现状 `<html ... data-theme="dark">`

- **不**在 enum 3 选 1（A-dark / C-dark / light）里
- theme-store task 启动期 hydration 时会改
- **当下** index.html 不是 3 选 1 —— CSS 走 `:root` 默认（A 暗，等价 A-dark）→ 无 user-visible break
- **静态 grep 看不一致** —— verifier 可能盯，frontend 知道即可
- 修复时机：theme-store task 顺手改 `index.html:2` 的 `data-theme` 为有效 enum 值（保持默认 A-dark 即可）

---

## Race 条件（priority 低）

### #9 快速点 cycle 3 下

- 3 invoke 排队 → better-sqlite3 同步无 race，但 IPC 响应顺序由 IPC runtime 决定
- 中间两次响应会触发中间两次 `applyTheme` → 中间两次 CSS 过渡
- **可能"闪一下"**，但**最终态正确**（最后一次响应 = 最后一次 set）
- 防御（frontend 自测发现再决定要不要修）：
  - 方案 A：store 加 `pendingSet: AbortController`，新 set 取消前一个
  - 方案 B：disable 按钮直到当前 set 完成
  - 方案 C：UI 上 debounce 200ms
- verifier 不查这个，frontend 自测发现再说

---

## M2 教训对齐

- 上面 #4-#7 都是端点反向触发 UI 联动的产物，跟 a3 PullState 加 'all' 后 `commits.ts:337 narrowing + ipc-client.ts alias 同步` 是**同源问题**
- `preferences.theme.get/set` 端点落地后，frontend 的 ui store / 3 entry points 是**必须同步的 downstream**
- backend 摆清楚等 frontend 接手 —— 任何 IPC schema 扩展必须联动 grep downstream

---

## verifier 收口时按本表 + backend 5 条 grep（共 12 条）

backend 5 条 + frontend 7 条 = 12 条 grep 项，全部对齐后才算 PASS。
</content>
</invoke>