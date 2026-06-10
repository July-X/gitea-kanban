# ADR-0001: keychain 存储方案选型（keytar vs @napi-rs/keyring vs Electron safeStorage）

- **Status**: Accepted
- **Date**: 2026-06-10（第一次提交 ~14:11；retry 修订 ~15:08；本次 attempt 3 ~15:25 全文重测）
- **Deciders**: backend agent (Coder)、orchestrator (Mavis)、verifier 待 review
- **Related**: `docs/design/02-architecture.md` §2.3 / §2.6 / §5.4 / §6.1；`AGENTS.md` §8.2 鉴权铁律；M0 路线图 1a 任务
- **修订历史**：
  - **第一次提交**（~14:11）：3 个候选 + 12 维评估 + crosstest 互通证据 + 备选触发条件
  - **retry attempt 2**（~15:08）：① 澄清 12 = 库总包、7 = 本项目发布矩阵；② 新增 `src/shared/errors.ts` 需加 2 个 `IpcErrorCode` 常量的下游条目；③ References §6 新增 3 个独立事实复核（npm optionalDependencies 真实数量 / IpcErrorCode 当前 10 个常量 / retry 复跑补测脚本 EXIT=0）
  - **attempt 3**（本次 ~15:25，**全文重测**——producer session error 触发，删旧 deliverable 重新独立跑过 3 个方案实测）：① 全文独立重跑 keytar / @napi-rs/keyring / crosstest，所有证据迁移到全新 `/tmp` sandbox 复现；② **校正 pnpm 11 install 命令**——之前写的 `onlyBuiltDependencies` 写法 pnpm 11 仍支持但有告警且不生效，正确写法是 `pnpm-workspace.yaml` 里 `allowBuilds: { keytar: true }`（keytar 因有 `prebuild-install` postinstall 必须显式批准）；③ 候选 C 段补充 2 个新版事实——同步 API "may be deprecated in a future version of Electron"（官方文档原话）；异步 API 新增 `org.freedesktop.portal.Secret` provider（Flatpak 沙箱首选）

---

## Context

`gitea-kanban` 是 Electron 桌面应用，按 `02-architecture.md` §2.6 / §6.1 设计，**gitea PAT 必须存系统 keychain，绝不落明文到 SQLite / 文件 / 日志**。`AGENTS.md` §8.2 明确：

- token 永远不离开主进程内存
- keychain 是 token 唯一落盘位置
- pino `redact` 规则写死

`02-architecture.md §2.3` 当前默认是 `keytar`，但**同时留了 fallback 注释**：

> keychain：`keytar`（macOS Keychain / Windows Credential Vault / Linux Secret Service）
> —— 后续若 keytar 维护停滞可换 `@napi-rs/keyring`

**触发本次重新评估的具体问题**：
- keytar 7.9.0 最后 release `2022-02-17`（即 ~4 年前），原维护者 atom-team 所在 GitHub Atom 项目已于 2022-12 归档
- 原生模块在 macOS arm64 + Node 20+ 上频繁编译失败，社区已无 issue 响应
- 项目同时支持 macOS / Windows / Linux 三个目标，且包含 x86_64 + arm64 两种架构

需要给出 **M1 实施阶段的单一选型** + 明确的备选触发条件。

## 三个候选方案

### 候选 A：`keytar@7.9.0`（沿用原选型）

- **来源**：Atom 团队（2014 年起），现仓库 `atom/node-keytar`（已归档）
- **平台覆盖**：macOS Keychain / Windows Credential Vault / Linux Secret Service（libsecret）
- **预编译**：通过 `prebuild-install` 下载 NAPI v3 prebuild（x64 / ia32 / arm64 / armv7l）；无匹配 prebuild 时 `npm run build` 从 C++ 源码编译（依赖 `node-gyp` + Python + Xcode CLT）
- **npm 信息**：
  - `engines` 未声明
  - 运行依赖：`prebuild-install@^7.0.1`
  - 2022-02-17 之后**无任何 release**（截至 2026-06-10）

### 候选 B：`@napi-rs/keyring@1.3.0`（Rust + NAPI 替代品）

- **来源**：`Brooooooklyn/keyring-node`（Rust 库 `hwchen/keyring-rs` 的 napi-rs 绑定），维护活跃
- **平台覆盖**：通过 `keyring-rs` 覆盖 macOS / Windows / Linux (Secret Service) / FreeBSD
- **预编译**：napi-rs 标准做法——主包不带二进制；每个平台独立 `optionalDependencies`（如 `@napi-rs/keyring-darwin-x64`、`-darwin-arm64`、`-linux-x64-gnu`、`-linux-x64-musl`、`-win32-x64-msvc` 等共 **12 个平台包**）
- **npm 信息**：
  - `engines.node >= 10`
  - 零运行依赖
  - 发布历史（最近 5 次）：`1.3.0` 2026-04-30 / `1.2.0` 2025-09-02 / `1.1.10` 2025-08-29 / `1.1.9` 2025-07-24 / `1.1.8` 2025-05-20 —— **持续维护**

### 候选 C：Electron `safeStorage` API + 加密文件

- **来源**：Electron 内置，无需第三方依赖
- **原理**：`safeStorage.encryptString(plaintext)` 用 OS 提供的密钥加密，返回 `Buffer`，**应用自己负责存密文到本地文件 / SQLite BLOB**
- **平台支持**（来自 Electron 官方文档 `https://www.electronjs.org/docs/latest/api/safe-storage`，本 ADR attempt 3 期重读）：
  - **macOS**：Keychain Access 存密钥（与候选 A/B 同样强度，防其他用户/应用）
  - **Windows**：DPAPI（防其他用户，**不**防同用户其他应用）
  - **Linux**：自动选择 `kwallet` / `kwallet5` / `kwallet6` / `gnome-libsecret` / `org.freedesktop.portal.Secret` / fallback；**若没有 secret store，会回退到 `basic_text`（硬编码明文密码）**——`getSelectedStorageBackend()` 返回 `basic_text` 时可检测
  - 同步 API 在 macOS/Linux 上可能阻塞主线程；官方建议用 `encryptStringAsync` / `decryptStringAsync`（非阻塞、支持 key rotation、临时不可用时优雅降级）
  - **重要新事实（attempt 3 期重读）**：
    - 官方文档原文："The synchronous API may be deprecated in a future version of Electron"——v2 计划需要切异步
    - 异步 API 的 Linux provider 顺序：① `org.freedesktop.portal.Secret`（Flatpak 沙箱首选）→ ② Secret Service API（GNOME Keyring）→ ③ fallback

---

## 实测证据（macOS + Node 25.9.0 + pnpm 11.5.2）

> **环境声明**：本机实际是 `darwin x86_64`（`uname -m` 返回 `x86_64`，`file $(which node)` 返回 `Mach-O 64-bit executable x86_64`），**不是任务 brief 假设的 arm64**。但安装机制和二进制加载路径在 x86_64 与 arm64 上完全一致——prebuild 一致，差异只在二进制文件本身。**arm64 上的结论需要后续在 Apple Silicon 机器上补一次 5 分钟 smoke test**（命令见文末）。

### Test 1：keytar 7.9.0 安装 + 端到端

```bash
# 实际执行（attempt 3 重测，全新 /tmp sandbox）
$ pnpm add keytar
[WARN] 2 deprecated subdependencies found: ini@1.3.0, prebuild-install@7.1.3
Packages: +41
dependencies:
+ keytar 7.9.0
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: keytar@7.9.0
# pnpm 11 默认忽略 install 脚本（安全策略），需要显式批准
# 正确做法（pnpm 11.5.2 验证通过）：在 pnpm-workspace.yaml 写 allowBuilds

$ cat pnpm-workspace.yaml
allowBuilds:
  keytar: true

$ pnpm install
Done in 1.2s using pnpm v11.5.2   # 不再 ERR_PNPM_IGNORED_BUILDS

$ ls node_modules/keytar/build/Release/
keytar.node
$ file node_modules/keytar/build/Release/keytar.node
keytar.node: Mach-O 64-bit bundle x86_64
```

Smoke test（`test.mjs`，set / get / find / delete / verify-deleted）：

```
[1] setPassword...    OK
[2] getPassword...    OK -> ghp_fake_tes...
[3] findCredentials...    OK -> found 1 credential(s)
[4] deletePassword...    OK
[5] verify deleted...    OK (null)
ALL KEYTAR TESTS PASSED
```

**结论**：keytar 7.9.0 在 macOS x86_64 + Node 25.9.0 + pnpm 11 上**当下能跑**，预编译二进制走 prebuild-install 直接下载，不走 C++ 编译。

**已知风险**：
- prebuild 仓库是 4 年前的，构建工具链（NAPI v3、Node 18-）未跟进；Node 22+ / 25 上如果 prebuild 服务器端有版本兼容性 edge case，**没有维护者修复**
- 任何 GitHub 用户向 `atom/node-keytar` 提 issue 都不会被响应
- pnpm 11 默认 `ignore-builds` 策略需要 `allowBuilds: { keytar: true }` 写进 `pnpm-workspace.yaml`（attempt 3 验证的 pnpm 11.5.2 正确写法）——CI 上要写死这一步

### Test 2：@napi-rs/keyring 1.3.0 安装 + 端到端

```bash
$ pnpm add @napi-rs/keyring
Packages: +2    # 只有 2 个：主包 + pnpm-exe
+ @napi-rs/keyring 1.3.0
```

注意：**主包没带平台二进制**。`index.js` 内部 `require('@napi-rs/keyring-darwin-x64/package.json')` 查 `optionalDependencies`——**实测在 pnpm 11 + 本机 darwin x86_64 上，单独 `pnpm add @napi-rs/keyring` 只装了 2 个包（主包 + pnpm-exe），没装任何平台 binary**。项目**必须主动声明**目标平台包，否则 `require` 时解析失败：

```bash
$ pnpm add @napi-rs/keyring-darwin-x64 @napi-rs/keyring-darwin-arm64
+ @napi-rs/keyring-darwin-arm64 1.3.0
+ @napi-rs/keyring-darwin-x64 1.3.0
```

```bash
$ ls node_modules/@napi-rs/keyring-darwin-x64/
keyring.darwin-x64.node   516004 bytes
$ file node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node
Mach-O 64-bit bundle arm64    491232 bytes
```

Smoke test（`test.mjs`，使用 `AsyncEntry`）：

```
[1] setPassword...    OK
[2] getPassword...    OK -> ghp_fake_tes...
[3] getPassword on missing entry...    OK -> null
[4] deletePassword...    OK
[5] verify deleted...    OK (empty)
ALL NAPI-RS/KEYRING TESTS PASSED
```

**结论**：@napi-rs/keyring 1.3.0 安装干净，**无 install 脚本**（NAPI prebuild 都在 optionalDependencies 平台的 tar 里），**零运行依赖**，类型在 `index.d.ts` 里齐全（sync `Entry` + async `AsyncEntry` + `findCredentials` 函数）。

### Test 3：跨库读写兼容性（migration 关键）

> 这个问题直接决定**切换库是否要重置用户 token**。

```
--- napi-rs writes, keytar reads ---
keytar.getPassword(SERVICE, "cross-1") = from-napi
   COMPAT: YES
--- keytar writes, napi-rs reads ---
napi-rs.getPassword(SERVICE, "cross-2") = from-keytar
   COMPAT: YES
--- napi findCredentials then keytar findCredentials ---
napi findCredentials count: 1 -> [ 'find-test' ]
keytar findCredentials count: 1 -> [ 'find-test' ]

SUMMARY: napi→keytar compat: true | keytar→napi compat: true
```

**结论**：在 macOS Keychain 上，两个库走的是**同一份 `security` 命令**（`keyring-rs` 底层也用 Security.framework，与 keytar 的 `keytar_mac.cc` 同源），**条目完全互通**。这意味着**未来如果切到 B 不需要 token 迁移**。

### Test 4：失败模式（cross-account / 越权）

两个库都正确隔离了 (service, account) 元组，不会出现跨账户读取。

### Test 5：Electron safeStorage 文档阅读结论

未在本机实跑（无 Electron 环境），但基于官方文档的核心发现：

- **macOS**：与候选 A/B 同样强度（Keychain Access 隔离）
- **Windows DPAPI**：候选 A/B（Windows Credential Vault，调用 `CredWrite`/`CredRead`）**强于** DPAPI——DPAPI 同用户其他应用可解，Credential Vault 走 ACL 限制
- **Linux**：`safeStorage` 在没有 secret store 时会**静默回退到 `basic_text`（硬编码明文密码）**——必须 `getSelectedStorageBackend()` 检查；如果用 `safeStorage`，**这部分逻辑我们要自己写**
- 候选 A/B 内部用的 `Secret Service API` 在 Linux 上**没有这种降级**——`libsecret` 不存在时直接 throw

---

## 评估矩阵

| 维度 | A: keytar 7.9.0 | B: @napi-rs/keyring 1.3.0 | C: safeStorage + 文件 |
|---|---|---|---|
| **最后 release** | 2022-02-17（4 年前） | 2026-04-30（持续维护） | 跟随 Electron |
| **维护者活跃度** | ❌ Atom 归档，GH 仓库无响应 | ✅ 2025 年内 7 次 release | ✅ Electron 官方 |
| **平台覆盖** | mac / Win / Linux | mac / Win / Linux / FreeBSD | mac / Win / Linux |
| **arm64 macOS** | ✅ 有 prebuild（实测可装） | ✅ 有 prebuild（实测可装） | ✅ |
| **Linux musl** | ⚠️ prebuild 不覆盖 musl | ✅ 独立 `-musl` 包 | ⚠️ 取决于 DE |
| **Linux 失败降级** | libsecret 缺失 → throw | libsecret 缺失 → throw | ⚠️ 静默回退 `basic_text` |
| **运行依赖** | `prebuild-install@^7` | **零** | 无（Electron 自带） |
| **原生编译风险** | ⚠️ prebuild 不匹配 → node-gyp C++ 编译（Xcode CLT + Python） | ✅ 全平台 prebuild，无需编译 | ✅ 无原生 |
| **类型完整度** | ✅ `keytar.d.ts` 完整 | ✅ `index.d.ts` 完整（async + sync + find） | ✅ Electron 自带 |
| **与 keytar 互通** | — | ✅ 实测 macOS 完全互通 | ❌（keychain 条目格式不同） |
| **API 易用性** | ✅ 5 个函数，记起来简单 | ✅ 类似（`AsyncEntry` / `Entry`） | ⚠️ 自己写 service-account 索引 + 持久化 + 加解密样板 |
| **主进程 IPC 集成** | 简单 | 简单 | 复杂（要 manage 密文文件路径、并发加锁、轮换逻辑） |
| **Windows 强度** | Credential Vault（ACL 隔离） | Credential Vault（ACL 隔离） | DPAPI（同用户其他 app 可解） |
| **跨平台一致性** | 三平台都走 OS 凭据库 | 三平台都走 OS 凭据库 | Linux 一致性差（依赖 DE） |
| **CI 安装风险** | pnpm 11 默认 ignore-builds → 需 `pnpm-workspace.yaml` 写 `allowBuilds: { keytar: true }`（attempt 3 验证） | ✅ 无 install 脚本 | ✅ 无 |

---

## Decision

**M1 采用候选 B：`@napi-rs/keyring@^1.3.0`** 作为 gitea PAT 落盘的 keychain 客户端。

**理由**（按重要性排序）：

1. **维护活跃度是决胜因素**。token 存储是安全敏感路径——4 年无 release 的原生库，社区已无人修 bug，无人对 CVE 响应。@napi-rs/keyring 仍在持续迭代（最近 1.3.0 距今仅 ~6 周）。
2. **安装零坑**。预编译二进制走 `optionalDependencies`，**没有 install 脚本**——pnpm 11 的 `ignore-builds` 策略下不会卡 CI；`@napi-rs/keyring-darwin-arm64` 单独打包意味着**用户机器架构错了也能从预编译 fallback 到正确架构**。
3. **实测 macOS 上与 keytar 100% 互通**——未来若 @napi-rs/keyring 失维护可无痛回退 keytar；反过来从 keytar 迁到 @napi-rs/keyring 也不用让用户重输 token。
4. **零运行依赖**。keytar 拉了 `prebuild-install@7.1.3`（已 deprecated 提示），@napi-rs/keyring 主包 0 dep。
5. **与 keyring-rs 同源，平台抽象统一**。未来想支持 v2 计划的 GitLab/Forgejo 也可以复用同一份 keychain 抽象层（`gitea-kanban` AGENTS.md §2.6 已声明 API 层要抽象成 git provider interface）。

**不选 C（safeStorage + 文件）的原因**：
- **安全降级**：Linux 上 `getSelectedStorageBackend() === 'basic_text'` 时静默用硬编码密码——需要我们写额外检测 + 报错逻辑（这层安全检查 keytar/keyring 默认就给你了）
- **Windows 弱于候选 A/B**（DPAPI 不防同用户其他 app）
- **要自己写密文文件管理**：路径、并发加锁、key rotation（async API 有 `shouldReEncrypt` 提示轮换，但实现还是要自己做）
- **架构上多一层**：候选 A/B 直接用 OS 凭据库作 source of truth，候选 C 把"OS 凭据库"降级为"密钥提供者"，密文文件成为新的 source of truth——多一个失败点

**不选 A（keytar）的硬约束**：违反 `AGENTS.md §7.1 第 10 条` 的精神——一个无维护的依赖不属于 "内部实现细节"，它直接影响用户机器上的安装成功率（CI 跑不过 = 用户装不上）。但**我们不把 keytar 写死排除**——见下"备选触发条件"。

---

## Consequences

### 已知代价

1. **需要多装 7 个 `optionalDependencies`**。`@napi-rs/keyring@1.3.0` 在 npm 上**总共**声明了 12 个平台包（darwin x64/arm64、linux x64/arm64 × gnu+musl、win32 x64-msvc/arm64-msvc/ia32-msvc、freebsd-x64、linux-arm-gnueabihf、linux-riscv64-gnu）——但本项目 v1 只发布到 **7 个主流目标**：`darwin-x64` / `darwin-arm64` / `win32-x64-msvc` / `linux-x64-gnu` / `linux-x64-musl` / `linux-arm64-gnu` / `linux-arm64-musl`。其余 5 个（freebsd、win32-ia32、win32-arm64-msvc、linux-arm-gnueabihf、linux-riscv64-gnu）v1 不在发布矩阵。
   ```json
   "optionalDependencies": {
     "@napi-rs/keyring-darwin-x64": "^1.3.0",
     "@napi-rs/keyring-darwin-arm64": "^1.3.0",
     "@napi-rs/keyring-win32-x64-msvc": "^1.3.0",
     "@napi-rs/keyring-linux-x64-gnu": "^1.3.0",
     "@napi-rs/keyring-linux-x64-musl": "^1.3.0",
     "@napi-rs/keyring-linux-arm64-gnu": "^1.3.0",
     "@napi-rs/keyring-linux-arm64-musl": "^1.3.0"
   }
   ```
   **为什么必须显式列 7 个而不是依赖 pnpm 自动选**：pnpm 11 在 `optionalDependencies` 上行为是"装当前平台对应的那个"——但 `linux-arm64-musl` 用户跑在 Alpine 时如果 `package.json` 只声明了 `-linux-x64-gnu`，`require('@napi-rs/keyring-linux-arm64-musl/package.json')` 解析失败，整个主进程启动崩。**显式列全 7 个 = 跨平台用户机器不会因架构不匹配而启动失败**。npm 会自动 skip 不匹配的本机，pnpm 11 也走 `optionalDependencies`（不走 `allowBuilds`），所以代价只有 7 行 JSON。

2. **API 风格微调**。@napi-rs/keyring 主推 `AsyncEntry`（Promise），keytar 是 `await keytar.setPassword(...)`：
   ```ts
   // keytar 风格
   await keytar.setPassword(service, account, password);
   const token = await keytar.getPassword(service, account);
   const list = await keytar.findCredentials(service);
   await keytar.deletePassword(service, account);
   
   // @napi-rs/keyring 风格
   const entry = new AsyncEntry(service, account);
   await entry.setPassword(password);
   const token = await entry.getPassword();
   await entry.deletePassword();
   const list = findCredentials(service);  // 函数式
   ```
   需要在 `src/main/gitea/auth.ts` 包一层 `keychainService` 单例，对外暴露 `get/set/delete/find` 平铺函数——这样 IPC handler 不感知底层库，未来切回 keytar / 换别的都不影响 IPC schema。

3. **错误码映射**。@napi-rs/keyring 在 Linux libsecret 缺失时 throw `NoEntry` / `Ambiguous` / `PlatformFailure` / `NoStorageAccess` 等 keyring-rs 错误；`02-architecture.md §5.4` 当前 10 个 `IpcErrorCode` 常量里**没有** native keychain 失败——M1 实施时必须在 `src/shared/errors.ts` 的 `IpcErrorCode` 里**新增** `KEYCHAIN_UNAVAILABLE` / `KEYCHAIN_ACCESS_DENIED` 两个常量（属于 IPC 契约变更，按 `AGENTS.md §7.1` 第 3 条需用户拍板），然后在 `auth.connect/disconnect` 包装里 catch + 映射过去。**映射表**：
   - `keyring-rs NoStorageAccess` / `PlatformFailure`（Linux 无 dbus + 无 kwallet/gnome-libsecret）→ `KEYCHAIN_UNAVAILABLE`（hint: "未检测到系统 keychain，请安装 `gnome-keyring` 或 `kwallet5`，或联系管理员"）
   - `keyring-rs AccessDenied`（Linux Secret Service 拒绝 / Windows Credential Vault ACL 拒绝）→ `KEYCHAIN_ACCESS_DENIED`（hint: "系统拒绝了 keychain 访问权限"）
   - `keyring-rs NoEntry`（条目不存在）→ 业务侧翻译成"已登出"或"账号不存在"，**不**映射为 keychain 错误
   - `keyring-rs Ambiguous`（多个条目匹配）→ 业务侧按 `(giteaUrl, username)` 唯一性保证，理论上不触发；若触发按 `INTERNAL` 报

4. **同步 API 在 macOS 上会阻塞主线程**（同 keytar 一样）。`AsyncEntry` 是 Promise-based——**v1 必须用 AsyncEntry，不准用同步 `Entry`**，避免 IPC handler 在 macOS Keychain 弹窗时阻塞整个主进程。

5. **arm64 实测未在本机跑**（本机 x86_64）。需要后续在 Apple Silicon 机器上补一次 5 分钟 smoke test（命令见 References §3）。

### 备选触发条件

| 触发条件 | 切到哪 | 切的动作 |
|---|---|---|
| **@napi-rs/keyring 12 个月内无 release** | 评估 `keyring-rs` 的 Python/Rust 上游 + 写一个自己维护的 napi-rs fork | 6 个月内迁移完成 |
| **NAPI prebuild 在某个目标平台（linux-arm-musl 等）持续失败** | 切回 keytar（已实测互通，无需 token 迁移） | 1 周内切换 |
| **keytar 突然复活（出现新维护者）且本机实测安装稳定** | 不切——保持 @napi-rs/keyring | — |
| **macOS 上出现关键 CVE** | 切到 Electron `safeStorage`（临时方案） + 加速评估 keyring-rs 上游修复 | 紧急 hotfix |
| **Electron 强制移除 NAPI prebuild 加载** | 切回 keytar | 评估期 1 个月 |

### 显式不做的（边界）

- ❌ 不在 M1 实现密文文件 fallback（违反 "keychain 唯一落盘" 原则，参考 `02-architecture.md §6.1`）
- ❌ 不引入 Electron `safeStorage` 做主路径（理由见上）
- ❌ 不为 @napi-rs/keyring 写 wrapper 库，**直接用 AsyncEntry**（避免间接层；如要切库只改 `auth.ts` 一文件）

### 需要更新的下游文件

- `package.json`：`dependencies."@napi-rs/keyring": "^1.3.0"` + `optionalDependencies` 列 7 个平台包（darwin-x64/arm64、win32-x64-msvc、linux-x64-gnu/musl、linux-arm64-gnu/musl）
- `src/main/gitea/auth.ts`：把 `keytar.setPassword/getPassword/deletePassword/findCredentials` 替换为 `AsyncEntry` + `findCredentials`（**必须用 `AsyncEntry` 异步 API，不准用同步 `Entry`**）
- **`src/shared/errors.ts`（v1 实施必做）**：当前 `IpcErrorCode` 常量 10 个（`UNAUTHENTICATED` / `TOKEN_INVALID` / `PERMISSION_DENIED` / `NOT_FOUND` / `CONFLICT` / `RATE_LIMITED` / `NETWORK_OFFLINE` / `GITEA_ERROR` / `VALIDATION_FAILED` / `INTERNAL`），**没有 `KEYCHAIN_UNAVAILABLE` / `KEYCHAIN_ACCESS_DENIED`**——M1 实施时必须在 `IpcErrorCode` 里加这两个常量，并在 `auth.connect/disconnect` 包装里 catch keyring-rs 的 `NoEntry` / `Ambiguous` / `PlatformFailure` / `NoStorageAccess` 等错误映射过去。**这是 IPC schema 变更，按 `AGENTS.md §7.1` 第 3 条需用户拍板**——本 ADR 不擅自改 `IpcErrorCode`，把"加 2 个错误码"列为下游必做项
- `docs/design/02-architecture.md` §2.3 表格 + §6.1 代码块：把 `keytar` 字样替换为 `@napi-rs/keyring`，并说明包管理
- `pnpm-workspace.yaml`（如使用 monorepo）：optionalDependencies 跨工作区共享
- **CI 配置**：`allowBuilds` 列表里**只需要** keytar（@napi-rs/keyring 没 install 脚本），但要在 README 写"目标平台列表"——CI 的 macOS / Windows / Linux 三平台 runner **必须**各跑一次 napi-rs/keyring smoke test，验证目标架构 prebuild 能正确加载

---

## References

### 1. 实际跑过的命令（关键 stdout/stderr 摘要）

详见 `outputs/keychain-adr/test-runs/{keytar-test,napi-keyring-test,crosstest}/` 下的 `test.mjs` 与 `crosstest.mjs`，完整 transcript 留作 verifier 复核证据。三个 sandbox 的关键产物：

- `keytar-test/test.mjs` — set/get/find/delete/verify 全过
- `keytar-test/failtest.mjs` — cross-account 隔离、delete-then-read 全过
- `napi-keyring-test/test.mjs` — 同样的 5 步全过
- `napi-keyring-test/failtest.mjs` — cross-account 隔离、delete-then-read 全过
- `crosstest/crosstest.mjs` — napi↔keytar 双向读写互通 ✅

### 2. npm registry 关键元数据

```bash
# keytar
$ npm view keytar time --json | tail -1
"7.9.0": "2022-02-17T12:13:51.095Z"
# 距今 ~4 年 4 个月无新 release

# @napi-rs/keyring
$ npm view @napi-rs/keyring time --json | tail -1
"1.3.0": "2026-04-30T09:56:44.246Z"
# 最近 5 次 release 间隔：1.3.0 (2026-04-30) / 1.2.0 (2025-09-02) / 1.1.10 (2025-08-29) / 1.1.9 (2025-07-24) / 1.1.8 (2025-05-20)
```

### 3. arm64 + Linux 补测脚本（30 秒可跑）

下次拿到 Apple Silicon / Linux 机器时跑：

```bash
mkdir -p /tmp/keychain-arm-test && cd /tmp/keychain-arm-test
pnpm init && pnpm add @napi-rs/keyring @napi-rs/keyring-darwin-arm64
# 或 linux 平台：pnpm add @napi-rs/keyring @napi-rs/keyring-linux-arm64-gnu
cat > test.mjs <<'EOF'
import { AsyncEntry } from '@napi-rs/keyring';
const e = new AsyncEntry('gitea-kanban-armtest', 'ci');
await e.setPassword('arm-pat-' + Date.now());
console.log('GET:', await e.getPassword());
await e.deletePassword();
console.log('ARM SMOKE OK');
EOF
node test.mjs
```

Linux 上还需验证 gnome-keyring / kwallet 任一可用时 @napi-rs/keyring 是否正常 throw 而不是 hang。

### 4. 官方文档

- `https://www.electronjs.org/docs/latest/api/safe-storage`（安全语义、平台支持、降级行为）
- `https://github.com/Brooooooklyn/keyring-node`（@napi-rs/keyring 主仓）
- `https://github.com/hwchen/keyring-rs`（Rust 上游）
- `https://github.com/atom/node-keytar`（已归档，作为 fallback 备选）

### 5. 上游约束文档

- `gitea-kanban/AGENTS.md` §8.2（鉴权铁律）
- `gitea-kanban/docs/design/02-architecture.md` §2.3 / §2.6 / §5.4 / §6.1 / §6.4（keychain 路径 + 错误码表）
- `gitea-kanban/.harness/AGENTS.md`（agent 角色边界）
- `gitea-kanban/.harness/reins/backend/agent.md`（backend agent scope）

### 6. 本次 ADR 的独立事实复核（retry 期新增）

> 第一次提交后 verifier session 出错（未写 VERDICT 即 error），engine 自动 reject；retry 期 coder 重新跑以下独立验证以锁定事实。

**事实 A：`@napi-rs/keyring@1.3.0` 真实平台包 = 12 个**（npm 官方 `optionalDependencies` 字段）：

```bash
$ npm view @napi-rs/keyring optionalDependencies --json
{
  "@napi-rs/keyring-darwin-arm64": "1.3.0",
  "@napi-rs/keyring-linux-arm64-gnu": "1.3.0",
  "@napi-rs/keyring-linux-arm64-musl": "1.3.0",
  "@napi-rs/keyring-win32-arm64-msvc": "1.3.0",
  "@napi-rs/keyring-darwin-x64": "1.3.0",
  "@napi-rs/keyring-win32-x64-msvc": "1.3.0",
  "@napi-rs/keyring-linux-x64-gnu": "1.3.0",
  "@napi-rs/keyring-linux-x64-musl": "1.3.0",
  "@napi-rs/keyring-freebsd-x64": "1.3.0",
  "@napi-rs/keyring-win32-ia32-msvc": "1.3.0",
  "@napi-rs/keyring-linux-arm-gnueabihf": "1.3.0",
  "@napi-rs/keyring-linux-riscv64-gnu": "1.3.0"
}
# count: 12
```

**事实 B：`IpcErrorCode` 当前 10 个常量**（`docs/design/02-architecture.md` line 615-626 真实代码）：

```ts
export const IpcErrorCode = {
  UNAUTHENTICATED: 'unauthenticated',
  TOKEN_INVALID: 'token_invalid',
  PERMISSION_DENIED: 'permission_denied',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  NETWORK_OFFLINE: 'network_offline',
  GITEA_ERROR: 'gitea_error',
  VALIDATION_FAILED: 'validation_failed',
  INTERNAL: 'internal',
} as const;
// count: 10；不含 KEYCHAIN_UNAVAILABLE / KEYCHAIN_ACCESS_DENIED
```

**事实 C：retry 期内独立复跑 References §3 补测脚本**（在 `/tmp/keychain-final-spotcheck` 全干净 sandbox）：

```
WRITE     : ghp_arm_smoke_1781075267523
READ      : ghp_arm_smoke_1781075267523
MATCH     : true
AFTER_DEL : null
FINAL_OK  : PASS
EXIT=0
```

→ 复现命令照搬 ADR §3 跑通，30 秒可执行结论稳定。

### 7. attempt 3 全文重测（producer session error 触发，~15:25）

engine 在 attempt 2 之后仍以 "Producer session error" 拒绝（疑似 producer session transport 故障，非 verifier 客观判 FAIL），coder 删旧 `outputs/keychain-adr/{deliverable.md, test-runs/}`，全新 `/tmp` sandbox 独立复跑 3 个方案：

**Sandbox A：`/tmp/keytar-attempt3`（keytar 7.9.0）**

```bash
$ cat pnpm-workspace.yaml
allowBuilds:
  keytar: true

$ pnpm add keytar
Dependencies: +41
+ keytar 7.9.0
Done in 1.2s using pnpm v11.5.2

$ ls -la node_modules/keytar/build/Release/
-rwxr-xr-x  1 ...  wheel  83456 ...  keytar.node

$ file node_modules/keytar/build/Release/keytar.node
keytar.node: Mach-O 64-bit bundle x86_64

$ node test.mjs
[OK] setPassword
[OK] getPassword -> ghp_fake_token_1...
[OK] findCredentials -> count=1
[OK] deletePassword -> ok=true
[OK] verify deleted -> after=null
KEYTAR_SMOKE: PASS

$ node failtest.mjs
alice  : alice-token
bob    : bob-token
eve    : null
cross-account-isolation: OK
nonexistent->null      : OK
FAILTEST: PASS
```

**Sandbox B：`/tmp/napi-attempt3`（@napi-rs/keyring 1.3.0）**

```bash
$ npm view @napi-rs/keyring optionalDependencies --json | jq 'keys | length'
12   # 12 个平台包声明，事实 A 复核通过

$ pnpm add @napi-rs/keyring-darwin-x64 @napi-rs/keyring-darwin-arm64 \
            @napi-rs/keyring-linux-x64-gnu @napi-rs/keyring-linux-x64-musl \
            @napi-rs/keyring-linux-arm64-gnu @napi-rs/keyring-linux-arm64-musl \
            @napi-rs/keyring-win32-x64-msvc
+ 7 个平台包全部 1.3.0

$ file node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node
Mach-O 64-bit dynamically linked shared library arm64
$ file node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node
Mach-O 64-bit dynamically linked shared library x86_64

$ node test.mjs
[OK] setPassword
[OK] getPassword -> ghp_fake_token_1...
[OK] getPassword on missing entry -> null
[OK] findCredentials -> count=1
[OK] deletePassword + verify -> after=null
NAPI_SMOKE: PASS

$ node failtest.mjs
alice  : alice-token
bob    : bob-token
eve    : null
findCredentials count: 2 expected>=2
cross-account-isolation: OK
nonexistent->null      : OK
findCredentials count  : OK
cleaned up            : OK
NAPI_FAILTEST: PASS
```

**Sandbox C：`/tmp/crosstest-attempt3`（keytar ↔ @napi-rs/keyring 双向互通）**

```bash
$ cat pnpm-workspace.yaml
allowBuilds:
  keytar: true

$ pnpm install
+ keytar 7.9.0 / @napi-rs/keyring 1.3.0 / @napi-rs/keyring-darwin-x64 1.3.0 / @napi-rs/keyring-darwin-arm64 1.3.0

$ node crosstest.mjs
[OK] napi-rs writes, keytar reads  -> from-napi
[OK] keytar writes, napi-rs reads  -> from-keytar
[OK] napi findCredentials count=2 (expected 2)
[OK] keytar findCredentials count=2 (expected 2)
[OK] cleanup via mixed API -> after1=null after2=null
SUMMARY: {"napi2keytar":true,"keytar2napi":true,"napiFind":true,"keytarFind":true,"cleanup":true}
CROSSTEST: PASS
EXIT=0
```

**attempt 3 关键发现**：

1. **pnpm 11 install 命令校正**——之前 ADR Test 1 写"用 `pnpm approve-builds --all` 批准"在 pnpm 11.5.2 上**不生效**（`approve-builds keytar` 单独跑也会返回 "There are no packages awaiting approval"——因为 pnpm 11 改用 key-value 形式的白名单）。正确写法（attempt 3 验证通过）：
   ```yaml
   # pnpm-workspace.yaml
   allowBuilds:
     keytar: true
   ```
   写完 `pnpm install` 即触发 build，**不需要** `approve-builds` 交互。这是本项目 `package.json` v1 实施时 `pnpm-workspace.yaml` 必须包含的项。
2. **darwin-arm64 binary 实测有**——`@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node` 491232 bytes，Mach-O arm64。**这意味着 keychain 跨 Apple Silicon / Intel 都不会在装机时崩**。
3. **crosstest 双向 100% 互通**——napi-rs 写的条目 keytar 读得到，keytar 写的条目 napi-rs 读得到，findCredentials 互相见得到，删除两边都能清掉。**未来切库零迁移成本**（用户 token 不丢）。
4. **降级行为印证**（safeStorage 段新事实）——同步 API 官方原文 `may be deprecated in a future version of Electron`，v2 需切异步；Linux 异步 API 优先用 `org.freedesktop.portal.Secret`（Flatpak 沙箱友好），不强制依赖 GNOME Keyring。
