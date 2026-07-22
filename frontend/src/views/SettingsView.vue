<script setup lang="ts">
/**
 * SettingsView —— 用户偏好设置面板
 *
 * v1.1.2 起加 "外观" 分组（入口 2，tech-refine §15.1）：
 *   - 2 主题单选（暗色 / 浅色）—— v1.2 拍板从 3 主题收敛
 *   - onChange 立即调 uiStore.applyTheme —— CSS 150ms 过渡 + 异步 IPC 持久化
 *   - 不做保存按钮（点选即生效），区别于 polling interval（数值输入需要手动保存）
 *
 * polling interval 分组保持 v1 行为：
 *   - 默认 5 min
 *   - 30s ~ 30 min
 *   - 改完立即生效（App.vue watch 监听 + 重启 timer）
 *
 * v1.1.3 起加 "账号" 分组（入口 3，task #22）：
 *   - 显示当前连接的 gitea 服务器地址 + 登录用户
 *   - 提供「更新连接」按钮：弹 modal 改 giteaUrl + token
 *   - 提交后：auth.connect 走新地址 + 主动 refresh repo store + 跳 /board
 *     让所有 view 在 mount 时重新拉数据
 *   - 安全：原 token **不**显示（防 dev tools / 截屏），新 token 同样 password 框
 *
 * 设计：
 *   - 不做 i18n（v1 硬编码中文）
 *   - 数值输入框 + 步进按钮，避免自由输入整数错误
 *   - 外观分组用 `.settings-group`（与 polling 的 `.settings__section` BEM 解耦）
 */
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { RefreshCw } from 'lucide-vue-next';
import { useSettingsStore, SETTINGS_LIMITS } from '@renderer/stores/settings';
import { useUiStore, THEME_DISPLAY_NAME, type Theme } from '@renderer/stores/ui';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { showToast } from '@renderer/lib/toast';
import { logInfo, logError } from '@renderer/lib/frontend-log';
import {
  commitsGitgraphGetWorkspace,
  systemOpenPath,
  openDesktopFolder,
  exportLogs,
  copyRecentLogs,
  normalizeError,
} from '@renderer/lib/ipc-client';
import {
  testGitBinary,
  openGitBinaryPicker,
  type TestGitBinaryResult,
} from '@renderer/lib/ipc-client';
import {
  GITHUB_CLI_INSTALL_LABEL,
  GITHUB_CLI_INSTALL_URL,
  GITHUB_CLI_REQUIRED_HINT,
  GITHUB_CLI_REQUIRED_MESSAGE,
} from '@renderer/lib/github-cli-guide';
import { useUpdate } from '@renderer/composables/useUpdate';
import {
  Version,
  GetCheckUpdatesPref,
  SetCheckUpdatesPref,
} from '../../wailsjs/wailsjs/go/main/App';
// v2.2：WorkspaceMigrateDialog 已移除（workspace 路径不可改）

const settings = useSettingsStore();
const ui = useUiStore();
const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();
const router = useRouter();

// ============================================================
// v0.6.0：故障排查 —— 导出日志 / 最近日志
// ============================================================
const exportingLogs = ref(false);
const copyingLogs = ref(false);

async function onExportLogs(): Promise<void> {
  if (exportingLogs.value) return;
  exportingLogs.value = true;
  logInfo('settings', '导出日志到桌面', '');
  try {
    const result = await exportLogs({ maxLogs: 5 });
    showToast({
      type: 'success',
      message: '日志已导出到桌面',
      description: `共 ${result.logCount} 个日志文件，${(result.logBytes / 1024).toFixed(1)}KB`,
    });
  } catch (err) {
    const normalized = normalizeError(err);
    logError('settings', '导出日志失败', normalized.messageText);
    showToast({ type: 'error', message: '导出失败', description: normalized.messageText });
  } finally {
    exportingLogs.value = false;
  }
}

async function onCopyRecentLogs(): Promise<void> {
  if (copyingLogs.value) return;
  copyingLogs.value = true;
  logInfo('settings', '复制最近日志', '');
  try {
    const result = await copyRecentLogs({ maxBytes: 64 * 1024 });
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(result.content);
    }
    showToast({
      type: 'success',
      message: '已复制到剪贴板',
      description: `最近日志 ${result.bytes} 字节`,
    });
  } catch (err) {
    const normalized = normalizeError(err);
    logError('settings', '复制最近日志失败', normalized.messageText);
    showToast({ type: 'error', message: '复制失败', description: normalized.messageText });
  } finally {
    copyingLogs.value = false;
  }
}

async function onOpenDesktopFolder(): Promise<void> {
  try {
    await openDesktopFolder();
  } catch (err) {
    const normalized = normalizeError(err);
    showToast({ type: 'error', message: '打开桌面文件夹失败', description: normalized.messageText });
  }
}

// ============================================================
// v0.4.0：Git 二进制设置（独立卡片「Git 二进制」）
// ============================================================
//
// 设计：
//   - 默认内嵌 git 2.55.0（macos + windows），Linux 走系统 PATH
//   - 用户可改路径（macOS / Windows / Linux 都允许）：
//     macOS 通常 /opt/homebrew/bin/git、/usr/local/bin/git、.app/Contents/MacOS/git
//     Windows 通常 C:\Program Files\Git\cmd\git.exe
//     Linux 通常 /usr/bin/git
//   - 「选择文件」走平台特定对话框（macOS 允许所有文件，Windows 限定 .exe）
//   - 「测试」调用 <path> --version 验证；macOS 检测 quarantine 属性
//   - 「解除隔离」macOS 主动 xattr -d com.apple.quarantine
//   - 改完「保存」调后端 setGitBinaryPath 写 prefs + 进程内立即 SetUserOverride
//
// 表单直接绑 settings.gitBinaryPath（Pinia ref），未保存时 store 已 dirty 但未持久化；
// 后端 setGitBinaryPath 在用户点「保存」时落盘，watch 不需要（store 自管）。
const gitBinaryTestResult = ref<TestGitBinaryResult | null>(null);

/**
 * v0.5：2-button mode picker（user-mid-turn steer）
 *
 *   'embedded' / 'system' / 'custom'
 *
 * - 'embedded' → backend userOverride = SentinelEmbedded → 强制走内嵌 binary（init
 *   后 smoke test 已验证可运行才生效；否则报错让用户选 system）
 * - 'system'   → backend userOverride = "" → 强制走 PATH git（用户 OS 自带）
 * - 'custom'   → backend userOverride = 绝对路径 → 走用户填的具体路径
 *
 * 默认值：'system'（v0.4.0 fix-1 经验：PATH git 跨平台稳定优先）
 *
 * 变更历史：v0.4.0 时期用 input 让用户填 userOverride 路径，UI 信息密度高；
 * v0.5 采取 segmented control 只显示两个主选项 + advanced details 折叠 custom。
 */
/**
 * backend gitbinary sentinel magic string，v0.5 引入。
 * 后端 gitbinary.ResolveGitBinaryPath 看到 userOverride == EMBEDDED_MODE_MARKER
 *   → 强制走 Init 释放的 embedded binary（不再 fallback PATH）。
 * 同步：app/gitbinary/runner.go 同名常量；任一变动需两边同改。
 */
const EMBEDDED_MODE_MARKER = '$EMBEDDED$'

/**
 * v0.5-mid2 精简状态：mode 只保留 2 个选项
 *   'embedded' → sentinel=EMBEDDED_MODE_MARKER → 走 Init 释放的 binary
 *   'custom'   → userOverride=文件选择对话框选的 path → 走用户选的 git
 *
 * v0.5-original 的 'system' 分支已删除（语义上等价于 custom 但交互更隐晦）。
 * 默认 'custom' 是兼容老 user state.json（prefs["app.gitBinaryPath"] 非空路径）；
 * 如果 state.json 是空 / sentinel，启动期 GitHub 设定仍未跑过时本 UI 默认空。
 */
const gitBinaryMode = ref<'embedded' | 'custom'>('embedded');
const gitBinaryModeLoading = ref(false);

/** 默认版本号：仅 UI 陪字节用，有 TestGitBinaryResult 时会被实际覆盖 */
const gitBinaryEmbeddedVersion = computed(() => settings.gitBinary?.embeddedVersion ?? '2.55.0');

/** v0.5-mid2 状态行：TestGitBinaryResult 有值优先使用其版 */
const gitBinaryEffectiveVersion = computed(
  () => gitBinaryTestResult.value?.version || gitBinaryEmbeddedVersion.value,
);

/**
 * v0.5-mid2：点「使用内嵌 Git」按钮 → sentinel + test
 * 不需要走 dialog（已是默认 fallback / 已释放）。
 */
async function onSelectEmbedded(): Promise<void> {
  if (gitBinaryModeLoading.value) return;
  gitBinaryModeLoading.value = true;
  try {
    const cfg = await settings.saveGitBinaryPath(EMBEDDED_MODE_MARKER);
    gitBinaryMode.value = 'embedded';
    gitBinaryTestResult.value = await testGitBinary(cfg.effectivePath);
    if (gitBinaryTestResult.value?.ok === false) {
      showToast({
        type: 'warn',
        message: '内嵌 git 未能跑通',
        description: '将临时 fallback 到 PATH git；建议选「使用系统装的 Git」',
        duration: 4000,
      });
    }
  } finally {
    gitBinaryModeLoading.value = false;
  }
}

/**
 * v0.5-mid2：点「使用系统安装的 Git」按钮 → 弹文件选择对话框
 * 用户选完后走 user-custom path + test。
 * 弹窗是平台特定（macOS *  / Windows *.exe / Linux *）。
 */
async function onPickAndUseSystemGit(): Promise<void> {
  if (gitBinaryModeLoading.value) return;
  let picked = '';
  try {
    picked = await openGitBinaryPicker();
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    showToast({
      type: 'error',
      message: '打开文件选择器失败',
      description: err.messageText ?? err.message ?? '请稍后重试',
    });
    return;
  }
  if (!picked) return; // 用户取消
  gitBinaryModeLoading.value = true;
  try {
    const cfg = await settings.saveGitBinaryPath(picked);
    gitBinaryMode.value = 'custom';
    gitBinaryTestResult.value = await testGitBinary(cfg.effectivePath);
  } finally {
    gitBinaryModeLoading.value = false;
  }
}

/* v0.5-mid2 删除：onStripQuarantine / onPickGitBinary / onSelectMode / onCustomPathBlur /
   shortPath / gitBinaryQuarantined / gitBinaryPlatformHint / gitBinaryStripping / gitBinaryPicking
   —— API 仍保留在 ipc-client.ts 与后端，后续有需求可重读 commit 97aa7f9 加回。*/

// ============================================================
// 应用数据目录分组（v2.x · 数据根目录 = 全局路径）
// ============================================================
//
// v2.x 设计（user 拍板）：
//   - 用户选的是"数据根目录" (DataRoot)，如 ~/.gitea-kanban/
//   - workspace 是应用根据业务在 DataRoot 下自动创建的子目录
//     (用于放 git repos，路径不可改、用户不应直接选择)
//   - DataRoot 启动期若不存在自动 mkdir -p
//   - 设置页只读展示 DataRoot + 状态
//   - 提供"打开应用数据目录"按钮调 system.openPath 打开 DataRoot
//   - 旧版的 setWorkspace / 选目录 / 重置 / 迁移对话框 全部移除
const dataRootPath = ref('');
const dataRootValidated = ref(true);
/** 内部 git 仓库目录 (DataRoot + "/workspace")，仅前端调试可见，UI 不展示 */
const workspacePathInternal = ref('');
/** "打开应用数据目录" 按钮的 loading 态（避免双击） */
const openingDataDir = ref(false);

/**
 * 脱敏后的应用数据目录路径（把用户目录替换成 ~）
 *
 * - Windows:  C:\Users\xxx  →  ~
 * - macOS:    /Users/xxx     →  ~
 * - Linux:    /home/xxx      →  ~
 *
 * 显示用（title 属性仍保留完整路径供用户查看原文）。
 */
const maskedDataRootPath = computed(() => {
  if (!dataRootPath.value) return '—';
  const p = dataRootPath.value;
  // Windows: C:\Users\username  or  C:/Users/username
  const win = p.match(/^([A-Za-z]:[\\/]+Users[\\/]+[^\\/]+)/);
  if (win) return '~' + p.slice(win[1].length);
  // macOS: /Users/username
  const mac = p.match(/^(\/Users\/[^\/]+)/);
  if (mac) return '~' + p.slice(mac[1].length);
  // Linux: /home/username
  const linux = p.match(/^(\/home\/[^\/]+)/);
  if (linux) return '~' + p.slice(linux[1].length);
  return p;
});

/** 启动期加载当前 dataRoot 信息（只读） */
(async (): Promise<void> => {
  try {
    const resp = await commitsGitgraphGetWorkspace();
    dataRootPath.value = resp.dataRoot;
    workspacePathInternal.value = resp.workspacePath;
    dataRootValidated.value = resp.validated;
  } catch {
    // getWorkspace 失败 → 静默（不阻塞设置页）
  }
})();

/** 打开系统文件管理器到应用数据目录 (DataRoot, 不是 workspace) */
async function onOpenDataDir(): Promise<void> {
  openingDataDir.value = true;
  try {
    await systemOpenPath({ path: dataRootPath.value });
  } catch (e) {
    const err = e as { messageText?: string; message?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '打开目录失败';
    showToast({ type: 'error', message: msg });
  } finally {
    openingDataDir.value = false;
  }
}

/** 外观分组 2 选 1（v1.2 收敛 · 与 tech-refine §14 token 矩阵 + §15.1 单选规格同步） */
const themeOptions: ReadonlyArray<{ value: Theme; label: string; desc: string }> = [
  { value: 'dark', label: THEME_DISPLAY_NAME.dark, desc: '夜间长时间使用推荐' },
  { value: 'light', label: THEME_DISPLAY_NAME.light, desc: '白天或打印场景' },
];

/**
 * 主题切换 —— onChange 回调
 *
 * 不 await：applyTheme 内部已 fire-and-forget 持久化（localStorage + DOM 同步 / IPC 异步），
 * UI 上**不**应该等 sqlite 写完。失败由 store 内部 toast。
 */
function onThemeChange(theme: Theme): void {
  void ui.applyTheme(theme);
}

/** 编辑中的值（毫秒） */
const draftMs = ref<number>(settings.pollingIntervalMs);
const saving = ref(false);

const minutesLabel = computed(() => {
  const m = Math.round(draftMs.value / 60000);
  return m.toString();
});

function onMinutesChange(e: Event): void {
  const target = e.target as HTMLInputElement;
  const n = Number(target.value);
  if (Number.isFinite(n)) {
    draftMs.value = Math.max(1, Math.round(n)) * 60 * 1000; // 输入按分钟
  }
}

async function onSave(): Promise<void> {
  if (
    draftMs.value < SETTINGS_LIMITS.MIN_POLLING_INTERVAL_MS ||
    draftMs.value > SETTINGS_LIMITS.MAX_POLLING_INTERVAL_MS
  ) {
    showToast({
      type: 'error',
      message: '数值超出范围',
      description: `间隔必须在 ${Math.round(SETTINGS_LIMITS.MIN_POLLING_INTERVAL_MS / 1000)} 秒到 ${Math.round(SETTINGS_LIMITS.MAX_POLLING_INTERVAL_MS / 60000)} 分钟之间`,
    });
    return;
  }
  saving.value = true;
  try {
    await settings.setPollingIntervalMs(draftMs.value);
    showToast({
      type: 'success',
      message: '已保存',
      description: `仓库列表每 ${Math.round(draftMs.value / 60000)} 分钟自动刷新`,
    });
  } catch (e) {
    const err = e as { message?: string };
    showToast({ type: 'error', message: '保存失败', description: err.message ?? '请稍后重试' });
  } finally {
    saving.value = false;
  }
}

// v2.2 (user 拍板 2026-06-22)：原 onWorkspaceSave / onWorkspaceReset / onBrowseDirectory 全部移除
// workspace 路径不可改，无需保存 / 重置 / 选目录
// 替代：onOpenDataDir 调 system.openPath 打开系统文件管理器到应用数据目录

// ============================================================
// ===== 账号分组（v1.1.3 · task #22）=====
// ============================================================
//
// 设计：显示当前 gitea 服务器 + 登录用户；点「更新连接」弹 modal 改 giteaUrl + token。
// 提交流程：
//   1. 调 auth.connect(新 giteaUrl, 新 token) —— main 端会
//      先 disconnect 旧账号（清 keychain + 内存），再 connect 新账号
//      （auth.ts:60-78 里 connect 内部已走 status 刷新，等价于重建连接）
//   2. 主动 refresh repo store（list 仓库）
//   3. 清掉 branch store 选中（之前选中的分支可能在旧 gitea 上不存在）
//   4. 跳 /board —— BoardView onMounted 重拉 columns
//
// 同步刷新策略：v1 没有 main → renderer 推送 auth.change 事件机制（grep 0 命中），
// 不在每个 view 写 watch 监听 auth.accounts 变化；最稳的是 connect 成功后
// **跳到 board** 让所有 view 在 mount 时重拉。
// （M3+ 推 auth.change 事件后可以省一次跳转）

const accountModalOpen = ref(false);
const newGiteaUrl = ref('');
const newToken = ref('');
const showNewToken = ref(false);
const updatingAccount = ref(false);
const accountLocalError = ref<string | null>(null);

function openAccountModal(): void {
  // 预填当前 giteaUrl（方便用户只改 token / 或只确认 URL 不动）
  newGiteaUrl.value = auth.currentGiteaUrl;
  newToken.value = '';
  accountLocalError.value = null;
  showNewToken.value = false;
  accountModalOpen.value = true;
}

function closeAccountModal(): void {
  if (updatingAccount.value) return; // 提交中禁止关
  accountModalOpen.value = false;
}

function validateUrlLocal(url: string): string | null {
  if (!url.trim()) return '请输入 gitea 地址';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'gitea 地址必须以 http:// 或 https:// 开头';
    }
  } catch {
    return 'gitea 地址格式不正确（示例：https://gitea.example.com）';
  }
  return null;
}

function validateTokenLocal(t: string): string | null {
  if (!t.trim()) return '请输入新的个人访问令牌';
  if (t.trim().length < 8) return '令牌长度至少 8 个字符';
  return null;
}

async function onUpdateAccount(): Promise<void> {
  accountLocalError.value = null;
  auth.clearError();
  const urlErr = validateUrlLocal(newGiteaUrl.value);
  if (urlErr) {
    accountLocalError.value = urlErr;
    return;
  }
  const tokenErr = validateTokenLocal(newToken.value);
  if (tokenErr) {
    accountLocalError.value = tokenErr;
    return;
  }
  const trimmedUrl = newGiteaUrl.value.trim();
  const trimmedToken = newToken.value.trim();
  // 短路：URL + token 都和当前一样 → 没必要重连
  if (trimmedUrl === auth.currentGiteaUrl) {
    showToast({ type: 'info', message: '账号配置未变，无需更新' });
    accountModalOpen.value = false;
    return;
  }
  updatingAccount.value = true;
  try {
    // 1) 重新连接（main 端内部走 disconnect 旧 + connect 新）
    await auth.connect(trimmedUrl, trimmedToken);
    // 2) 主动 reload repo 列表（新 gitea 的仓库 + project 标记）
    try {
      await repo.loadRepos('', true);
    } catch {
      /* repo.error 由 toast 兜底，下面覆盖 */
    }
    // 3) 清掉分支 store 的旧 selected（可能在新 gitea 上不存在）
    branch.select(null);
    // 4) 跳到 /timeline（Git Graph 核心视图）
    void router.push('/timeline');
    accountModalOpen.value = false;
    showToast({
      type: 'success',
      message: '账号已更新',
      description: `已切换到 ${trimmedUrl}，数据刷新中…`,
    });
  } catch {
    // 错误在 auth.error，模板已渲染
  } finally {
    updatingAccount.value = false;
  }
}

const accountErrorMessage = computed(() => {
  if (accountLocalError.value) return accountLocalError.value;
  if (auth.error) return auth.error.messageText;
  return null;
});

const accountErrorHint = computed(() => auth.error?.hint ?? null);
const currentAccountPlatform = computed(() => auth.accounts[0]?.platform ?? 'gitea');
const currentAccountIsGitHub = computed(() => currentAccountPlatform.value === 'github');

// ============================================================
// ===== v0.8.0 UI 收尾：应用更新卡片 =====
// ============================================================
//
// 设计：复用 v0.8.0 已有的 useUpdate composable + App.Version/GetCheckUpdatesPref/SetCheckUpdatesPref binding。
// 包含：当前版本号 + 手动检查更新按钮 + 是否自动检查开关。
const update = useUpdate();
const version = ref('dev');
const checkUpdatesPref = ref(true);
const prefSaving = ref(false);

const checking = computed(() => update.status.value.kind === 'checking');
const installingState = computed(() => update.status.value.kind === 'installing');

const updateStateLabel = computed(() => {
  const s = update.status.value;
  switch (s.kind) {
    case 'idle':
    case 'checking':
      return '正在检查更新...';
    case 'upToDate':
      return `已是最新版本 v${s.current}`;
    case 'available':
      return `发现新版本 v${s.info.latest}，点击下载`;
    case 'downloading': {
      const pct = s.total > 0 ? Math.round((s.received / s.total) * 100) : 0;
      return `下载中：${pct}% (${(s.received / 1024 / 1024).toFixed(1)}/${(s.total / 1024 / 1024).toFixed(1)} MB)`;
    }
    case 'verifying':
      return '正在校验签名...';
    case 'downloaded':
      return '新版本已就绪，点击下方按钮重启并安装';
    case 'installing':
      return '正在重启并安装...';
    case 'error':
      return `检查失败：${s.message}（可手动重试）`;
    default:
      return '';
  }
});

const devBuild = computed(() => update.status.value.kind === 'devBuild');

const checkButtonText = computed(() => {
  if (checking.value || installingState.value || devBuild.value) return '正在检查…';
  const s = update.status.value;
  if (s.kind === 'devBuild') return 'dev build 不支持检查更新';
  if (s.kind === 'available') return '下载更新';
  if (s.kind === 'downloaded') return '重启并安装';
  return '检查更新';
});

async function onLoadCurrentVersion(): Promise<void> {
  try {
    version.value = await Version();
  } catch (err) {
    logError('settings', '获取版本号失败', err instanceof Error ? err.message : String(err));
  }
}

async function onLoadCheckPref(): Promise<void> {
  try {
    checkUpdatesPref.value = await GetCheckUpdatesPref();
  } catch (err) {
    logError('settings', '读取自动更新偏好失败', err instanceof Error ? err.message : String(err));
  }
}

async function onCheckUpdateClick(): Promise<void> {
  const s = update.status.value;
  if (checking.value || installingState.value) return;
  if (s.kind === 'available') {
    await update.download();
    return;
  }
  if (s.kind === 'downloaded') {
    await update.install();
    return;
  }
  await update.check();
}

async function onToggleAutoUpdate(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  prefSaving.value = true;
  try {
    await SetCheckUpdatesPref(checked);
    checkUpdatesPref.value = checked;
    showToast({
      type: 'success',
      message: `已${checked ? '开启' : '关闭'}自动检查更新`,
      duration: 1800,
    });
  } catch (e) {
    const err = e as { message?: string };
    showToast({ type: 'error', message: '保存失败', description: err.message ?? '请稍后重试' });
    await onLoadCheckPref();
  } finally {
    prefSaving.value = false;
  }
}

onMounted(async () => {
  await Promise.all([onLoadCurrentVersion(), onLoadCheckPref()]);
});
</script>

<template>
  <div class="settings">
    <header class="settings__header">
      <h1>设置</h1>
    </header>

    <!-- 三栏网格布局（紧凑，避免滚动条） -->
    <div class="settings__grid">
      <!-- 数据同步 -->
      <section class="settings__card settings__card--compact">
        <h2>数据同步</h2>
        <div class="settings__inline-row">
          <label class="settings__label" for="polling-min">自动刷新间隔</label>
          <input
            id="polling-min"
            type="number"
            class="settings__input"
            :value="minutesLabel"
            min="1"
            :max="Math.round(SETTINGS_LIMITS.MAX_POLLING_INTERVAL_MS / 60000)"
            @change="onMinutesChange"
          />
          <span class="settings__unit">分钟</span>
          <button type="button" class="settings__save settings__save--inline" :disabled="saving" @click="onSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

      <!--
        v0.5 「Git 二进制」卡片（2-button 模式选择 + advanced details）
        user-mid-turn steer：只显示两个主选项
          - 「使用内嵌 Git」—— 显式强制走嵌入 v2 git 2.55.0（适合 amd64 mac/win build 场景）
          - 「使用系统安装的 Git」—— 走 PATH git（arm64 mac / Linux 默认，跨 arch 稳定）
        高级选项（手动填 path / platform 路径提示 / macOS quarantine 修复）折叠 details。
        状态行 1 句点出当前 path + 版本号。
        路径 tooltip only on hover（避免 1 行变两行）。
      -->
      <section class="settings__card settings__card--compact">
        <h2>Git 二进制</h2>

        <!--
          顶部状态行：当前生效路径 + git 版本号 + 状态图标
          （只用 1 句，连 room 都不报 path 问题；详细状态 details 里看）
        -->
        <p class="settings__hint settings__hint--mono">
          <span v-if="gitBinaryEffectiveVersion">
            <span v-if="gitBinaryTestResult?.ok === false">⚠</span>
            <span v-else>✓</span>
            git {{ gitBinaryEffectiveVersion }}
            <template v-if="gitBinaryMode === 'embedded'"> · 使用内嵌</template>
            <template v-else-if="gitBinaryMode === 'custom'"> · 自选路径</template>
          </span>
          <span v-else-if="gitBinaryModeLoading">加载中…</span>
          <span v-else>请选择一个 git 来源</span>
        </p>

        <!--
          v0.7.21 主交互区：radio 单选（对齐外观主题 / gh 二进制卡片）
          - 互斥：只有选中态高亮
          - 与外观主题共用 .settings__theme-opt 样式
        -->
        <div class="settings__theme-options" role="radiogroup" aria-label="Git 二进制来源">
          <label
            class="settings__theme-opt"
            :class="{ 'settings__theme-opt--active': gitBinaryMode === 'embedded' }"
          >
            <input
              type="radio"
              name="gitBinary"
              value="embedded"
              :checked="gitBinaryMode === 'embedded'"
              class="settings__theme-radio"
              @change="onSelectEmbedded"
            />
            <span class="settings__theme-label">使用内嵌 Git</span>
          </label>
          <label
            class="settings__theme-opt"
            :class="{ 'settings__theme-opt--active': gitBinaryMode === 'custom' }"
          >
            <input
              type="radio"
              name="gitBinary"
              value="custom"
              :checked="gitBinaryMode === 'custom'"
              class="settings__theme-radio"
              @change="onPickAndUseSystemGit"
            />
            <span class="settings__theme-label">使用系统安装的 Git</span>
          </label>
        </div>
      </section>


      <!-- 外观 -->
      <section class="settings__card settings__card--compact">
        <div class="settings__inline-row">
          <h2>外观</h2>
          <div class="settings__theme-options" role="radiogroup" aria-label="主题">
            <label
              v-for="opt in themeOptions"
              :key="opt.value"
              class="settings__theme-opt"
              :class="{ 'settings__theme-opt--active': ui.currentTheme === opt.value }"
            >
              <input
                type="radio"
                name="theme"
                :value="opt.value"
                :checked="ui.currentTheme === opt.value"
                class="settings__theme-radio"
                @change="onThemeChange(opt.value)"
              />
              <span class="settings__theme-label">{{ opt.label }}</span>
            </label>
          </div>
        </div>
      </section>

      <!-- v0.8.0 UI 收尾：应用更新卡片 -->
      <section class="settings__card settings__card--compact">
        <h2>应用更新</h2>
        <div class="settings__inline-row">
          <label class="settings__label">当前版本</label>
          <span class="settings__info-value mono">{{ version }}</span>
          <button
            type="button"
            class="settings__save settings__save--inline"
            :disabled="checking || installingState"
            @click="onCheckUpdateClick"
          >
            <RefreshCw :class="{ spin: checking }" :size="14" />
            {{ checkButtonText }}
          </button>
        </div>
        <div class="settings__field">
          <label class="settings__hint settings__hint--compact">
            <input
              type="checkbox"
              :checked="checkUpdatesPref"
              :disabled="prefSaving"
              @change="onToggleAutoUpdate"
            />
            启动时自动检查更新
          </label>
          <p v-if="updateStateLabel" class="settings__hint settings__hint--muted">
            {{ updateStateLabel }}
          </p>
          <p v-if="devBuild" class="settings__hint settings__hint--warn">
            dev build 不支持检查更新，请使用 release 版本
          </p>
        </div>
      </section>

      <!-- v0.7.x: 应用数据目录 + 故障排查 同行左右布局 -->
      <section class="settings__card">
        <h2>应用数据目录</h2>
        <div class="settings__info-row">
          <span class="settings__info-label">当前路径</span>
          <span class="settings__info-value mono" :title="dataRootPath">
            {{ maskedDataRootPath }}
          </span>
        </div>
        <div class="settings__info-row">
          <span class="settings__info-label">状态</span>
          <span class="settings__info-value">
            <span v-if="dataRootValidated" class="settings__status settings__status--ok">✓ 可用</span>
            <span v-else class="settings__status settings__status--warn">⚠ 路径不可用</span>
          </span>
        </div>
        <button
          type="button"
          class="settings__save"
          style="margin-top: var(--space-2); align-self: flex-start;"
          :disabled="openingDataDir || !dataRootPath"
          :title="dataRootPath ? '用系统文件管理器打开 ' + dataRootPath : '尚无数据目录'"
          @click="onOpenDataDir"
        >
          <span>{{ openingDataDir ? '打开中…' : '打开应用数据目录' }}</span>
        </button>
      </section>

      <!-- v0.6.0: 故障排查卡片 -->
      <section class="settings__card">
        <h2>故障排查</h2>
        <div class="settings__btn-row">
          <button
            type="button"
            class="settings__save"
            :disabled="exportingLogs"
            @click="onExportLogs"
          >
            {{ exportingLogs ? '正在导出…' : '导出日志到桌面' }}
          </button>
          <button
            type="button"
            class="settings__reset"
            :disabled="copyingLogs"
            @click="onCopyRecentLogs"
          >
            {{ copyingLogs ? '读取中…' : '复制最近日志' }}
          </button>
          <button
            type="button"
            class="settings__reset"
            @click="onOpenDesktopFolder"
          >
            打开桌面文件夹
          </button>
        </div>
        <p class="settings__hint settings__hint--compact">
          日志保存在数据目录下的 <code>logs/main/</code>，按天切分，保留 14 天。
          导出包含最近 5 个日志文件 + 当前应用状态（脱敏 token/password），
          一键「复制最近日志」适合贴到 GitHub issue 反馈问题。
        </p>
      </section>

      <!-- 账号（v0.9.x：放到最末，标识"基础信息/全局配置"，无关体验优先级） -->
      <section class="settings__card">
        <h2>账号</h2>
        <div class="settings__info-row">
          <span class="settings__info-label">地址</span>
          <span class="settings__info-value mono" :title="auth.currentGiteaUrl">
            {{ auth.currentGiteaUrl || '—' }}
          </span>
        </div>
        <div class="settings__info-row">
          <span class="settings__info-label">用户</span>
          <span class="settings__info-value">
            {{ auth.currentUser?.login ?? '—' }}
          </span>
        </div>
        <p v-if="currentAccountIsGitHub" class="settings__gh-guide">
          <strong>{{ GITHUB_CLI_REQUIRED_MESSAGE }}</strong>
          <span>{{ GITHUB_CLI_REQUIRED_HINT }}</span>
          <a :href="GITHUB_CLI_INSTALL_URL" target="_blank" rel="noopener noreferrer">
            {{ GITHUB_CLI_INSTALL_LABEL }}
          </a>
        </p>
        <button
          type="button"
          class="settings__save"
          :disabled="!auth.isConnected"
          :title="auth.isConnected ? '更新 gitea 地址或令牌' : '尚未连接'"
          @click="openAccountModal"
        >
          更新连接
        </button>
      </section>
    </div>
  </div>
    <Teleport to="body">
      <div v-if="accountModalOpen" class="account-modal" role="dialog" aria-modal="true">
        <div class="account-modal__backdrop" @click="closeAccountModal" />
        <div class="account-modal__card">
          <header class="account-modal__head">
            <h3>更新 gitea 连接</h3>
            <button
              type="button"
              class="account-modal__close"
              :aria-label="'关闭'"
              :disabled="updatingAccount"
              @click="closeAccountModal"
            >
              ×
            </button>
          </header>

          <p class="account-modal__hint">
            更换服务器或令牌后，应用会重新拉仓库、分支、看板数据。
            原令牌不会显示（已加密保存在本机 keychain）。
          </p>

          <form class="account-modal__form" @submit.prevent="onUpdateAccount">
            <div class="account-modal__field">
              <label class="account-modal__label" for="new-gitea-url">gitea 地址</label>
              <input
                id="new-gitea-url"
                v-model="newGiteaUrl"
                type="url"
                class="account-modal__input"
                placeholder="http://localhost:3000"
                autocomplete="url"
                spellcheck="false"
                :disabled="updatingAccount"
              />
            </div>

            <div class="account-modal__field">
              <label class="account-modal__label" for="new-gitea-token">新的个人访问令牌</label>
              <div class="account-modal__input-wrap">
                <input
                  id="new-gitea-token"
                  v-model="newToken"
                  :type="showNewToken ? 'text' : 'password'"
                  class="account-modal__input account-modal__input--with-icon"
                  placeholder="粘贴新令牌（至少 8 个字符）"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="updatingAccount"
                />
                <button
                  type="button"
                  class="account-modal__toggle"
                  :aria-label="showNewToken ? '隐藏令牌' : '显示令牌'"
                  :title="showNewToken ? '隐藏令牌' : '显示令牌'"
                  @click="showNewToken = !showNewToken"
                >
                  {{ showNewToken ? '隐藏' : '显示' }}
                </button>
              </div>
            </div>

            <div v-if="accountErrorMessage" class="account-modal__error" role="alert">
              <p class="account-modal__error-msg">{{ accountErrorMessage }}</p>
              <p v-if="accountErrorHint" class="account-modal__error-hint">{{ accountErrorHint }}</p>
            </div>

            <div class="account-modal__actions">
              <button
                type="button"
                class="account-modal__btn account-modal__btn--cancel"
                :disabled="updatingAccount"
                @click="closeAccountModal"
              >
                取消
              </button>
              <button
                type="submit"
                class="account-modal__btn account-modal__btn--primary"
                :disabled="updatingAccount"
              >
                {{ updatingAccount ? '正在切换…' : '保存并刷新数据' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- v2.2：工作区迁移对话框已移除（workspace 不可改，不需要迁移） -->
</template>

<style scoped>
/* ===== SettingsView v1.6 紧凑布局（三栏网格 + 不滚动） ===== */
.settings {
  flex: 1;
  padding: var(--space-4);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.settings__header {
  margin-bottom: var(--space-3);
  /* v1.5 区域边界 + v1.6.1 改主区中性色
   * 跟主区同色 (#F8FAFC 亮色 / #0F1115 暗色), 靠 border-bottom 1px 分层 */
  padding: var(--space-3) var(--space-4);
  background: var(--color-shell-main-bg);
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.settings__header h1 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

/* 三栏网格（自适应，不会出现水平滚动条） */
.settings__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--space-3);
  flex: 1;
  overflow-y: auto;
  align-content: start;
}
/* 工作区卡片横跨 2 列 */
.settings__card--wide {
  grid-column: 1 / -1;
}

/* 通用卡片 */
.settings__card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.settings__card--compact {
  padding: var(--space-3) var(--space-4);
  gap: var(--space-2);
}
.settings__card h2 {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  flex-shrink: 0;
}

/* 内联行（数据同步 label+input+unit+save 同行；外观 h2+主题 同行） */
.settings__inline-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* 字段 / 行 / 提示 */
.settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.settings__label {
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--color-text-secondary);
}
.settings__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.settings__input {
  width: 100px;
  padding: 6px 10px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
}
/**
 * v0.4.0：Git 二进制路径输入框（"Git 二进制" 卡片专用）
 *  - flex:1 让它占满 .settings__row 剩余空间
 *  - mono 字体让绝对路径更易读
 *  - 比 polling interval 输入框（100px）宽
 */
.settings__input--wide {
  flex: 1 1 auto;
  min-width: 200px;
  width: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-sm);
}
.settings__unit {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.settings__hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.4;
}
.settings__hint--compact {
  font-size: 10px;
  color: var(--color-text-muted);
  margin: 0;
}
/**
 * v0.5：单调一行状态（多用于 git binary 路径行）
 *   - monospace 字体让路径、版本号展示更对齐
 *   - --muted 变体让插入点（• 分隔符 + 路径部分）色调较柔，让主信息突出
 */
.settings__hint--mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.settings__hint--muted {
  color: var(--color-text-disabled, var(--color-text-muted));
}

/**
 * v0.5：seg-toggle 风格的 2-button 模式选择器
 *   - flex-row 容器，子按钮平分宽度
 *   - --active 高亮态走 primary bg，inactive 透明背景
 *   - 鼠标 hover 状态切换 animation
 *   - --meta 子元素用 secondary 色，让 2 个 button 主体看起来平衡
 */
.settings__mode-toggle {
  display: flex;
  gap: var(--space-2, 8px);
}
.settings__mode-btn {
  flex: 1 1 0;
  padding: 7px 12px;
  background: var(--color-bg-elevated, var(--color-bg-secondary, rgba(255, 255, 255, 0.04)));
  color: var(--color-text);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  font-size: var(--font-sm, 12px);
  font-weight: 500;
  cursor: pointer;
  text-align: center;
  transition: background 120ms var(--ease, ease), border-color 120ms var(--ease, ease), color 120ms var(--ease, ease);
  line-height: 1.2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.settings__mode-btn:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(128, 128, 128, 0.08));
  border-color: var(--color-border-hover, var(--color-primary, #74b830));
}
.settings__mode-btn--active {
  background: var(--color-primary-soft, rgba(116, 184, 48, 0.18));
  border-color: var(--color-primary, #74b830);
  color: var(--color-primary, #74b830);
}
.settings__mode-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.settings__mode-meta {
  font-size: var(--font-xs, 10px);
  font-weight: 400;
  color: var(--color-text-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  letter-spacing: 0;
}

/* 按钮 */
.settings__save {
  align-self: flex-start;
  padding: 6px 16px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
}
.settings__save:hover:not(:disabled) {
  background: var(--color-primary-hover);
}
.settings__save--inline {
  padding: 4px 12px;
  font-size: var(--font-xs);
}
.settings__save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.settings__reset {
  align-self: flex-start;
  padding: 6px 16px;
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  flex-shrink: 0;
}
.settings__reset:hover {
  border-color: var(--color-text-secondary);
  color: var(--color-text);
}

/* 按钮行（故障排查卡片：导出+复制 同行） */
.settings__btn-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* 主题切换 */
.settings__theme-options {
  display: flex;
  gap: var(--space-2);
}
.settings__theme-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  flex: 1;
}
.settings__theme-opt:hover {
  border-color: var(--color-primary);
}
.settings__theme-opt--active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.settings__theme-radio {
  accent-color: var(--color-primary);
  margin: 0;
  cursor: pointer;
}
.settings__theme-label {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
}

/* 信息行（账号 / 工作区路径） */
.settings__info-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-height: 20px;
}
.settings__info-label {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  min-width: 3.5em;
}
.settings__info-value {
  flex: 1 1 auto;
  font-size: var(--font-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings__info-value.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* badge + 状态 */
.settings__badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-radius: 10px;
  vertical-align: middle;
}
.settings__status {
  font-size: var(--font-xs);
}
.settings__status--ok {
  color: var(--color-success, #7db233);
}
.settings__status--warn {
  color: var(--color-warning, #f0ad4e);
}

/* ============== v1.1.3 task #22 · 更新连接 modal ============== */
.account-modal {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.account-modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  animation: account-modal-fade 150ms ease-out;
}
.account-modal__card {
  position: relative;
  width: min(420px, 100%);
  max-height: calc(100vh - 2 * var(--space-4));
  overflow-y: auto;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  /* v1.6 统一到 --shadow-lg 新柔和 token（去掉旧 --shadow-elevated 硬编码 fallback） */
  box-shadow: var(--shadow-lg);
  padding: var(--space-4);
  animation: account-modal-pop 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.account-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.account-modal__head h3 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--color-text);
}
.account-modal__close {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 22px;
  line-height: 1;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}
.account-modal__close:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--color-text);
}
.account-modal__close:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.account-modal__hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin: 0 0 var(--space-3);
  line-height: 1.5;
}

.settings__gh-guide {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: var(--space-2) 0 0;
  padding: var(--space-2);
  border: 1px solid color-mix(in srgb, var(--color-primary) 32%, var(--color-divider));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
}

.settings__gh-guide strong {
  color: var(--color-text);
  font-weight: 600;
}

.settings__gh-guide a {
  color: var(--color-primary);
  text-decoration: underline;
}

.account-modal__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.account-modal__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.account-modal__label {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.account-modal__input-wrap {
  position: relative;
  display: flex;
}
.account-modal__input {
  flex: 1 1 auto;
  height: 32px;
  padding: 0 var(--space-3);
  font-size: var(--font-sm);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
}
.account-modal__input--with-icon {
  padding-right: 56px;
}
.account-modal__input:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft, rgba(0, 0, 0, 0.08));
}
.account-modal__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.account-modal__toggle {
  position: absolute;
  right: 4px;
  top: 4px;
  bottom: 4px;
  padding: 0 var(--space-2);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color 150ms ease-out, background-color 150ms ease-out;
}
.account-modal__toggle:hover {
  color: var(--color-text);
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.06));
}
.account-modal__error {
  padding: var(--space-2) var(--space-3);
  background: var(--color-danger-soft, rgba(220, 38, 38, 0.1));
  border: 1px solid var(--color-danger, #dc2626);
  border-radius: var(--radius-sm);
}
.account-modal__error-msg {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--color-danger, #dc2626);
  font-weight: 500;
}
.account-modal__error-hint {
  margin: var(--space-1) 0 0;
  font-size: var(--font-xs);
  color: var(--color-danger, #dc2626);
  opacity: 0.85;
  line-height: 1.5;
}
.account-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.account-modal__btn {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-sm);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}
.account-modal__btn:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.06));
}
.account-modal__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.account-modal__btn--primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-on-primary, #fff);
}
.account-modal__btn--primary:hover:not(:disabled) {
  background: var(--color-primary-hover, color-mix(in srgb, var(--color-primary) 88%, white));
  border-color: var(--color-primary-hover, color-mix(in srgb, var(--color-primary) 88%, white));
}

@keyframes account-modal-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes account-modal-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0)   scale(1); }
}
/* v0.8.0 UI 收尾：spin icon animation */
.spin {
  animation: settings-spin 1s linear infinite;
  display: inline-block;
}
@keyframes settings-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .account-modal__backdrop,
  .account-modal__card {
    animation: none;
  }
}
</style>
