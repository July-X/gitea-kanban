# M7 e2e 补齐 + CI 收口

> **触发**：M5-fix-final-deliverable §6 follow-up（FU3 W3 e2e 复测）+ m4 遗留（W1/W2/W4 未跑通）
> **时间**：2026-06-13
> **结论**：✅ **4 e2e 全跑通 / 79 pass / 0 fail / CI 入口就位**

## 1. 结果

```
$ pnpm e2e:all
==========================================
M7 e2e 串跑结果
==========================================
  W1 (repos/branches/commits): PASS  (15/0)
  W2 (board/issue/labels):     PASS  (18/0)
  W3 (pulls/timeline):         PASS  (9/0 + 3 known-issue)
  W4 (auth/prefs):             PASS  (37/0)
==========================================
exit 0
```

| 维度 | 数据 |
|---|---|
| e2e 脚本数 | 4 (W1-W4) |
| 业务断言总数 | 79 (15+18+9+37) |
| 失败 | 0 |
| 已知 issue | 3 (Z1-Z3 schema 边缘，M5 fix-1 已修但 W3 脚本标注"意外通过") |
| 串跑耗时 | ~3 min（4 e2e + 2 次 ABI 切换） |
| ABI 切换 | 自动化（node 25 ↔ electron 41.7.2） |
| CI 入口 | `pnpm e2e:all` / `pnpm e2e:w1` / `e2e:w2` / `e2e:w3` / `e2e:w4` |

## 2. 关键修复（M7 落地）

### 2.1 sqlite.ts require → ESM import（M7 暴露的真 bug）

**问题**：
- W1 跑 `node _e2e-runner.mjs e2e-verify-w1.ts` → `initSqlite()` 报 `ReferenceError: require is not defined`
- 源文件 `src/main/cache/sqlite.ts:62` 写了 `const fs = require('node:fs') as typeof import('node:fs');`
- package.json 是 `"type": "module"`，ESM 模式下 `require` 未定义
- 旧 `e2e-verify-w1.sh` 走 esbuild bundle，自动把 `require` 转 ESM import → **掩盖了**这个 bug
- M6 的 `_e2e-runner.mjs` 不 bundle（直接跑 tsx 源码）→ 暴露 bug

**修法**（`src/main/cache/sqlite.ts`）：
```diff
- import { mkdirSync } from 'node:fs';
+ import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';

  // 1. probe 写权限
- const fs = require('node:fs') as typeof import('node:fs');
  let probeOk = false;
  try {
-   if (!fs.existsSync(dbDir)) {
-     fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
+   if (!existsSync(dbDir)) {
+     mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }
    const probePath = join(dbDir, `.probe-${process.pid}`);
-   const fd = fs.openSync(probePath, 'a');
-   fs.closeSync(fd);
-   fs.unlinkSync(probePath);
+   const fd = openSync(probePath, 'a');
+   closeSync(fd);
+   unlinkSync(probePath);
    probeOk = true;
  } catch (err) {
```

**为何不 regression**：
- electron-vite 编译主进程为 CJS（electron 主进程走 CJS 模式）→ `require` 在 CJS 输出里可用
- 改完后顶层 import 的 5 个 named export 同样兼容 CJS 输出（esbuild 自动处理）
- W3 复测 = 9/0 pass → 验证 M5/m6 改动无回归

**意义**：M7 4 件套的"源码直跑"路径把隐藏的 ESM bug 浮出水面。这是 e2e 补齐的额外收益。

### 2.2 e2e.sh 自动 ABI 切换（M7 落地）

**问题**：
- better-sqlite3 prebuilt 同时发 node ABI + electron ABI
- 默认装 electron ABI（dev/build 用）
- e2e 跑在 node 25 上 → 必须切到 node 25 ABI，否则 `The module was compiled against a different Node.js version`
- 旧 `e2e-verify-w1.sh` 手动切 2 次 ABI（node → 跑 → electron）
- W2/W3/W4 没 .sh，没自动切 → 跑前手动切

**修法**（新文件 `scripts/e2e.sh`）：
```bash
# 1. 切到 node 25 ABI
(cd "$BSQLITE_DIR" && npx -y prebuild-install --runtime=node --target=25.9.0)

# 2. 串跑 4 个 e2e（用 _e2e-runner.mjs）
for label,script in W1..W4; do
  node "$ROOT/scripts/_e2e-runner.mjs" "$ROOT/scripts/$script"
done

# 3. 切回 electron ABI（dev 兼容性）
(cd "$BSQLITE_DIR" && npx prebuild-install --runtime=electron --target="$ELECTRON_VERSION")
```

**用法**：
- `pnpm e2e:all` —— 一键跑 4 个 + 自动切 ABI
- `bash scripts/e2e.sh --keep-node` —— 跑完**不**切回（dev 前要 `pnpm rebuild:native`）

### 2.3 package.json 脚本统一（M7 落地）

新增 5 个脚本：
```json
"e2e:w1": "node scripts/_e2e-runner.mjs scripts/e2e-verify-w1.ts",
"e2e:w2": "node scripts/_e2e-runner.mjs scripts/e2e-verify-w2.ts",
"e2e:w3": "node scripts/_e2e-runner.mjs scripts/e2e-verify-w3.ts",
"e2e:w4": "node scripts/_e2e-runner.mjs scripts/e2e-verify-w4.ts",
"e2e:all": "bash scripts/e2e.sh"
```

**注意**：
- `e2e:w*` 是**单 namespace 跑**（**不**自动切 ABI，要求用户已切好）
- `e2e:all` 才自动切 ABI
- KB_TOKEN env 在 `e2e:all` 内设默认 9c3fdf27...（W1 内置同 token；W2/W3/W4 读 env）

### 2.4 W1 .sh 薄壳化（M7 落地）

**修前**（commit 4dba52d）：esbuild bundle + ABI switch + 跑 bundled
**修后**（M7）：ABI switch + 调 `_e2e-runner.mjs` + ABI 切回

**为何保留 .sh**：
- 用户的 6月 11 历史入口（不 reset）
- 习惯 bash wrapper 的 dev 继续用
- 跑 e2e:all 太重时单跑 w1

```bash
# 等价
bash scripts/e2e-verify-w1.sh        # 旧入口，但内部调 M6 runner
pnpm e2e:w1                          # 新入口
```

### 2.5 M6 4-件套复用（M7 确认）

W1/W2/W3/W4 全跑通 `_e2e-runner.mjs` 入口，确认 M6 4 件套设计稳：
1. `_electron-shim.mjs` —— ESM named exports（满足 ESM 静态分析）
2. `_electron-shim-resolver.mjs` —— ESM resolver hook（Node 20.6+ `register()`）
3. `_e2e-loader.mjs` —— `--import` 入口，调 `register()`
4. `_e2e-runner.mjs` —— spawn tsx + 透传 `NODE_OPTIONS=--import=...`

M6 §2.1 ESM 修复经验**完全**适用于 W1/W2/W4。W2/W4 之前没跑只是因为没时间，现在一次跑通说明 4 件套设计**正确**且**通用**。

## 3. W1-W4 跑通证据

| 脚本 | 业务断言 | 跑通日期 | 关键里程碑 |
|---|---|---|---|
| **W1** (repos/branches/commits) | 15 | 2026-06-13 M7 | 暴露 sqlite.ts require bug；15/0 pass 后 bug 修 |
| **W2** (board/issue/labels) | 18 | 2026-06-13 M7 | 一次跑通；M5 fix-1 IsoDateSchema offset ripple 验证（issue timestamps `+08:00` 解析正确） |
| **W3** (pulls/timeline) | 9 + 3 known | 2026-06-13 M6 (W3) + M7 (复测) | M6 FU3 405 case 中文文案兼容；M5 fix-1 ripple 修复 Z1-Z3 (意外通过 = 已修) |
| **W4** (auth/prefs) | 37 | 2026-06-13 M7 | auth.* 业务层等价路径（避免 tsx import electron CJS）；keychain 临时 service 不污染 dev |

**4 个 e2e 一次性串跑**：通过 `pnpm e2e:all` 完成，exit 0。

## 4. 4 件套 vs 旧 .sh 收口

| 路径 | M7 状态 | 备注 |
|---|---|---|
| `pnpm e2e:w1` | ✅ canonical（单 namespace） | 不切 ABI，要求用户切好 |
| `pnpm e2e:all` | ✅ canonical（4 namespace 串跑） | 自动切 ABI + 切回 |
| `bash scripts/e2e-verify-w1.sh` | ✅ thin wrapper | 保留（不 reset 用户 6月 11 的入口） |
| `bash scripts/e2e.sh --keep-node` | ✅ | 跑完不切回 ABI（debug 用） |
| esbuild bundle path (`.e2e-verify-*.bundled.mjs`) | ⚠️ 死代码 | .gitignored，自动清理；不再生成 |
| 旧 `e2e-verify-w1.sh` esbuild 流程 | ❌ 移除 | 见 §2.4 |

## 5. CI 集成建议

下一步（**M8 候选**）：

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [push, pull_request]
jobs:
  e2e:
    runs-on: macos-14  # gitea 测试实例 + better-sqlite3 native ABI
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm e2e:all
        env:
          KB_TOKEN: ${{ secrets.KB_TOKEN }}
```

**注意**：
- 必须在 macOS 跑（gitea 测试实例 + native ABI 切换需要 shell 权限）
- KB_TOKEN 用 secret 注入（**不**写在 workflow）
- pnpm e2e:all 自动切 ABI，CI 不需要额外步骤

## 6. 末行 VERDICT

**VERDICT: PASS**

- W1/W2/W3/W4 4 e2e 全跑通（79 pass / 0 fail）
- M6 4-件套设计**通用**（W1/W2/W4 一次跑通 = 设计稳）
- M6 修复（IsoDateSchema / 405 case / 中文文案）**无回归**
- M7 暴露真 bug：sqlite.ts `require()` → ESM import 转换
- package.json 5 个新脚本 + 1 个 bash 收口脚本
- CI 入口就位（pnpm e2e:all）
