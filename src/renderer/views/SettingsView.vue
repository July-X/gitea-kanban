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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingsStore, SETTINGS_LIMITS } from '@renderer/stores/settings';
import { useUiStore, THEME_DISPLAY_NAME, type Theme } from '@renderer/stores/ui';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBranchStore } from '@renderer/stores/branch';
import { showToast } from '@renderer/lib/toast';
import { commitsGitgraphGetWorkspace, commitsGitgraphSetWorkspace } from '@renderer/lib/ipc-client';

const settings = useSettingsStore();
const ui = useUiStore();
const auth = useAuthStore();
const repo = useRepoStore();
const branch = useBranchStore();
const router = useRouter();

// ============================================================
// 工作区分组（v1.5.3 · workspace path 配置）
// ============================================================
const workspacePath = ref('');
const workspaceDefault = ref(true);
const workspaceValidated = ref(true);
const workspaceSaving = ref(false);
const workspaceDraft = ref('');

/** 启动期加载当前 workspace 设置 */
(async (): Promise<void> => {
  try {
    const resp = await commitsGitgraphGetWorkspace();
    workspacePath.value = resp.cwd;
    workspaceDefault.value = resp.isDefault;
    workspaceValidated.value = resp.validated;
    workspaceDraft.value = resp.cwd;
  } catch {
    // getWorkspace 失败 → 静默（不阻塞设置页）
  }
})();

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

function onSecondsChange(e: Event): void {
  const target = e.target as HTMLInputElement;
  const n = Number(target.value);
  if (Number.isFinite(n)) {
    draftMs.value = Math.max(1, Math.round(n)) * 1000;
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

// ============================================================
// 工作区保存（v1.5.3）
// ============================================================
async function onWorkspaceSave(): Promise<void> {
  const cwd = workspaceDraft.value.trim();
  if (!cwd) {
    showToast({ type: 'error', message: '工作区路径不能为空' });
    return;
  }
  if (cwd === workspacePath.value) {
    showToast({ type: 'info', message: '工作区路径未变，无需保存' });
    return;
  }
  workspaceSaving.value = true;
  try {
    const resp = await commitsGitgraphSetWorkspace({ cwd });
    workspacePath.value = resp.cwd;
    workspaceDefault.value = false;
    showToast({
      type: 'success',
      message: '工作区已更新',
      description: `Git Graph 仓库将同步到 ${resp.cwd}/repos/...`,
    });
  } catch (e) {
    const err = e as { messageText?: string; message?: string; hint?: string };
    const msg = err.messageText ?? err.message ?? String(e) ?? '设置失败';
    showToast({ type: 'error', message: msg });
  } finally {
    workspaceSaving.value = false;
  }
}

/** 重置为默认路径 */
function onWorkspaceReset(): void {
  workspaceDraft.value = '~/.giteakanb/workspace（默认）';
  showToast({ type: 'info', message: '已重置为默认路径，点「保存」生效' });
}

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
    // 4) 跳到 /board —— BoardView mount 时重拉 columns
    void router.push('/board');
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
</script>

<template>
  <div class="settings">
    <header class="settings__header">
      <h1>设置</h1>
      <p class="settings__subtitle">调整应用行为偏好</p>
    </header>

    <section class="settings__section">
      <h2>数据同步</h2>
      <p class="settings__hint">
        App 默认每 <strong>{{ Math.round(settings.pollingIntervalMs / 60000) }}</strong> 分钟从 gitea 拉一次最新仓库列表。
        你也可以点底部状态栏的刷新按钮主动拉。
      </p>

      <div class="settings__field">
        <label class="settings__label" for="polling-min">自动刷新间隔（分钟）</label>
        <div class="settings__row">
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
        </div>
        <p class="settings__hint settings__hint--small">
          范围：1 ~ 30 分钟；当前设置保存在浏览器本地，不跨设备同步。
        </p>
      </div>

      <button type="button" class="settings__save" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </section>

    <section class="settings-group">
      <h2>外观</h2>
      <p class="settings__hint">
        切换应用配色，点选立即生效，下次启动自动恢复。当前设置保存在本地数据库，不跨设备同步。
      </p>

      <div class="settings-group__options" role="radiogroup" aria-label="主题">
        <label
          v-for="opt in themeOptions"
          :key="opt.value"
          class="settings-group__radio"
          :class="{ 'settings-group__radio--active': ui.currentTheme === opt.value }"
        >
          <input
            type="radio"
            name="theme"
            :value="opt.value"
            :checked="ui.currentTheme === opt.value"
            class="settings-group__radio-input"
            @change="onThemeChange(opt.value)"
          />
          <span class="settings-group__radio-label">{{ opt.label }}</span>
          <span class="settings-group__radio-desc">{{ opt.desc }}</span>
        </label>
      </div>
    </section>

    <!-- ============== 账号分组（v1.1.3 · task #22）============== -->
    <section class="settings-group">
      <h2>账号</h2>
      <p class="settings__hint">
        当前连接的 gitea 服务器和登录用户。修改后会重新拉仓库、分支、看板数据。
      </p>

      <div class="settings-group__account">
        <div class="settings-group__account-row">
          <span class="settings-group__account-label">gitea 地址</span>
          <span class="settings-group__account-value mono" :title="auth.currentGiteaUrl">
            {{ auth.currentGiteaUrl || '—' }}
          </span>
        </div>
        <div class="settings-group__account-row">
          <span class="settings-group__account-label">登录用户</span>
          <span class="settings-group__account-value">
            {{ auth.currentUser?.login ?? '—' }}
          </span>
        </div>
        <button
          type="button"
          class="settings__save"
          :disabled="!auth.isConnected"
          :title="auth.isConnected ? '更新 gitea 地址或令牌' : '尚未连接'"
          @click="openAccountModal"
        >
          更新连接
        </button>
      </div>
    </section>

    <!-- ============== 工作区分组（v1.5.3 · workspace path）============== -->
    <section class="settings-group">
      <h2>应用工作区</h2>
      <p class="settings__hint">
        Git Graph 自动同步所选仓库的本地根目录。
        仓库按 <code>${'${工作区}'}/repos/${'${owner}'}__${'${repo}'}.git</code> 路径存放。
      </p>

      <div class="settings-group__account">
        <div class="settings-group__account-row">
          <span class="settings-group__account-label">当前路径</span>
          <span class="settings-group__account-value mono" :title="workspacePath">
            {{ workspacePath || '—' }}
            <span v-if="workspaceDefault" class="settings__badge">默认</span>
          </span>
        </div>
        <div class="settings-group__account-row">
          <span class="settings-group__account-label">状态</span>
          <span class="settings-group__account-value">
            <span v-if="workspaceValidated" class="settings__status settings__status--ok">✓ 可用</span>
            <span v-else class="settings__status settings__status--warn">⚠ 路径不可用</span>
          </span>
        </div>
      </div>

      <div class="settings__field">
        <label class="settings__label" for="workspace-path">修改工作区路径</label>
        <input
          id="workspace-path"
          v-model="workspaceDraft"
          type="text"
          class="settings__input"
          placeholder="~/giteakanb/workspace（默认）"
          spellcheck="false"
        />
        <p class="settings__hint settings__hint--small">
          跨平台默认路径：macOS/Linux = <code>$HOME/.giteakanb/workspace</code>；Windows = <code>%USERPROFILE%\.giteakanb\workspace</code>
        </p>
      </div>

      <div class="settings__actions">
        <button
          type="button"
          class="settings__save"
          :disabled="workspaceSaving"
          @click="onWorkspaceSave"
        >
          {{ workspaceSaving ? '保存中…' : '保存工作区路径' }}
        </button>
        <button
          type="button"
          class="settings__reset"
          @click="onWorkspaceReset"
        >
          重置为默认
        </button>
      </div>
    </section>

    <!-- ============== 账号更新 modal ============== -->
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
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  padding: var(--space-6);
  overflow-y: auto;
}
.settings__header {
  margin-bottom: var(--space-5);
}
.settings__header h1 {
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.settings__subtitle {
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  margin: 0;
}
.settings__section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  padding: var(--space-5);
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.settings__section h2 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.settings__hint {
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  margin: 0;
  line-height: var(--line-relaxed);
}
.settings__hint--small {
  font-size: var(--font-xs);
}
.settings__hint--muted {
  color: var(--color-text-muted);
}
.settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.settings__label {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
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
.settings__input--inline {
  width: 80px;
  display: inline-block;
  margin: 0 4px;
}
.settings__unit {
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}
.settings__save {
  align-self: flex-start;
  padding: 8px 20px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  font-weight: 500;
  cursor: pointer;
}
.settings__save:hover:not(:disabled) {
  background: var(--color-primary-hover);
}
.settings__save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* 工作区 badge + 状态 + 重置按钮 */
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
.settings__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.settings__reset {
  align-self: flex-start;
  padding: 8px 20px;
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.settings__reset:hover {
  border-color: var(--color-text-secondary);
  color: var(--color-text);
}

/* =====================================================================
 * 外观分组（v1.1.2 主题切换入口 2 · tech-refine §15.1）
 *
 * 设计：
 *   - 与 polling 的 `.settings__section` 同基础（圆角 / padding / divider / max-width）
 *   - 主色装饰条（border-left: 3px solid --color-primary）区分"主题"分组的视觉权重
 *   - BEM 解耦：单独命名 .settings-group，避免与 polling 数据类分组混用
 *   - radio 行用 padding + border 凸显"可选项"，hover/active 用 --color-primary 强调
 * ===================================================================== */
.settings-group {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-left: 3px solid var(--color-primary);
  border-radius: var(--radius-md);
  padding: var(--space-5);
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-5);
}
.settings-group h2 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.settings-group__options {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.settings-group__radio {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  cursor: pointer;
  transition:
    border-color 150ms ease-out,
    background-color 150ms ease-out;
}
.settings-group__radio:hover {
  border-color: var(--color-primary);
}
.settings-group__radio--active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.settings-group__radio-input {
  /* 浏览器原生 radio，accent-color 用主题主色跟随（亮/暗自动适配） */
  accent-color: var(--color-primary);
  margin: 0;
  cursor: pointer;
}
.settings-group__radio-label {
  font-size: var(--font-md);
  font-weight: 500;
  color: var(--color-text);
}
.settings-group__radio-desc {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  margin-left: auto;
}

/* ============== v1.1.3 task #22 · 账号分组 ============== */
.settings-group__account {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.settings-group__account-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}
.settings-group__account-label {
  flex: 0 0 5.5em;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}
.settings-group__account-value {
  flex: 1 1 auto;
  font-size: var(--font-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-group__account-value.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.settings-group__account .settings__save {
  align-self: flex-start;
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
  box-shadow: var(--shadow-elevated, 0 12px 32px rgba(0, 0, 0, 0.24));
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
@media (prefers-reduced-motion: reduce) {
  .account-modal__backdrop,
  .account-modal__card {
    animation: none;
  }
}
</style>
