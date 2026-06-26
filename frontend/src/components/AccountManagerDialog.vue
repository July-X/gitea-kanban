<script setup lang="ts">
/**
 * AccountManagerDialog —— 账号管理弹窗
 *
 * 功能：
 *   - 显示所有历史登录过的账号（avatar + login + giteaUrl）
 *   - 点击"切换"→ 选中该账号变成当前用户
 *   - 点击"移除"→ 从历史中删除该账号（keychain + localStore）
 *   - 底部"退出并移除"→ 移除当前账号并跳回 /auth
 *   - 底部"添加新账号"→ 内嵌连接表单
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { X, User, LogOut, UserPlus, Check } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { showToast } from '@renderer/lib/toast';
import {
  GITHUB_CLI_INSTALL_LABEL,
  GITHUB_CLI_INSTALL_URL,
  GITHUB_CLI_REQUIRED_HINT,
  GITHUB_CLI_REQUIRED_MESSAGE,
} from '@renderer/lib/github-cli-guide';
import type { GiteaAccountDto } from '@renderer/types/dto';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const auth = useAuthStore();
const repo = useRepoStore();
const router = useRouter();

// ===== 切换账号 =====
async function onSwitch(account: GiteaAccountDto): Promise<void> {
  try {
    await auth.switchAccount(account.id);
    // 切换后重载数据
    repo.repos.length = 0;
    repo.selectProject(null);
    void repo.persistLastSelected(null, null, '');
    await repo.loadRepos('', true);
    showToast({
      type: 'success',
      message: '已切换账号',
      description: account.platform === 'github'
        ? 'GitHub 仓库会使用 gh 快速加载提交记录'
        : undefined,
    });
    close();
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: '切换失败', description: err.messageText ?? '' });
  }
}

// ===== 移除单个账号 =====
async function onRemove(account: GiteaAccountDto): Promise<void> {
  try {
    await auth.disconnectOne(account.giteaUrl, account.username);
    showToast({ type: 'success', message: `已移除 ${account.username}` });
    // 如果移除的是当前账号，重载状态
    if (auth.accounts.length === 0) {
      repo.repos.length = 0;
      repo.selectProject(null);
      void repo.persistLastSelected(null, null, '');
      await router.push('/auth');
      close();
    }
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: '移除失败', description: err.messageText ?? '' });
  }
}

// ===== 退出并移除当前账号 =====
async function onLogoutAndRemove(): Promise<void> {
  const current = auth.accounts[0];
  if (!current) return;
  try {
    await auth.disconnectOne(current.giteaUrl, current.username);
    repo.repos.length = 0;
    repo.selectProject(null);
    void repo.persistLastSelected(null, null, '');
    showToast({ type: 'success', message: '已退出并移除当前账号' });
    await router.push('/auth');
    close();
  } catch (e) {
    const err = e as { messageText?: string };
    showToast({ type: 'error', message: '退出失败', description: err.messageText ?? '' });
  }
}

// ===== 添加新账号 =====
// v2.x:跟 AuthView 对齐,支持 Gitea / GitHub 两平台
// GitHub 走固定 URL(https://github.com),不显示地址输入框
const showAddForm = ref(false);
/** 添加账号时选择的平台(Gitea / GitHub) */
const addPlatform = ref<'gitea' | 'github'>('gitea');
const newGiteaUrl = ref('http://127.0.0.1:3000');
const newToken = ref('');
const showNewToken = ref(false);
const addLoading = ref(false);
const addError = ref<string | null>(null);

/** 添加账号时的平台选项 */
const addPlatforms = [
  { value: 'gitea' as const, label: 'Gitea（自托管）' },
  { value: 'github' as const, label: 'GitHub' },
];

async function onAddAccount(): Promise<void> {
  addError.value = null;
  // GitHub 走固定 URL,前端不显示地址输入框
  const url = addPlatform.value === 'github' ? 'https://github.com' : newGiteaUrl.value.trim();
  const token = newToken.value.trim();
  if (addPlatform.value === 'gitea' && !url) { addError.value = '请输入 gitea 地址'; return; }
  if (token.length < 8) { addError.value = '令牌至少 8 个字符'; return; }
  addLoading.value = true;
  try {
    // v2.x:把平台透传给 auth.connect,Go 端走对应 adapter
    await auth.connect(url, token, addPlatform.value);
    await repo.loadRepos('', true);
    showToast({ type: 'success', message: '新账号已添加' });
    showAddForm.value = false;
    newToken.value = '';
    close();
  } catch (e) {
    const err = e as { messageText?: string };
    addError.value = err.messageText ?? '连接失败';
  } finally {
    addLoading.value = false;
  }
}

function close(): void {
  emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
}

/** 是否是当前活跃账号 */
function isCurrent(account: GiteaAccountDto): boolean {
  return account.id === auth.accounts[0]?.id;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="am-overlay" role="dialog" aria-modal="true" @keydown="onKeydown">
      <div class="am-dialog">
        <!-- 标题 -->
        <header class="am-header">
          <h2 class="am-title">账号管理</h2>
          <button type="button" class="am-close" @click="close"><X :size="16" /></button>
        </header>

        <!-- 账号列表 -->
        <div class="am-list">
          <div
            v-for="account in auth.accounts"
            :key="account.id"
            class="am-account"
            :class="{ 'am-account--current': isCurrent(account) }"
          >
            <div class="am-account__info">
              <img
                v-if="account.userInfo?.avatarUrl"
                :src="account.userInfo.avatarUrl"
                class="am-account__avatar"
                alt=""
              />
              <User v-else :size="20" class="am-account__avatar-fallback" />
              <div class="am-account__detail">
                <span class="am-account__login">
                  {{ account.userInfo?.login ?? account.username }}
                  <span v-if="isCurrent(account)" class="am-badge">当前</span>
                </span>
                <span class="am-account__url mono">{{ account.giteaUrl }}</span>
              </div>
            </div>
            <div class="am-account__actions">
              <button
                v-if="!isCurrent(account)"
                type="button"
                class="am-btn am-btn--ghost"
                @click="onSwitch(account)"
              >
                切换
              </button>
              <button
                type="button"
                class="am-btn am-btn--ghost am-btn--danger"
                :title="isCurrent(account) ? '退出并移除此账号' : '从历史中移除'"
                @click="onRemove(account)"
              >
                移除
              </button>
            </div>
          </div>
          <div v-if="auth.accounts.length === 0" class="am-empty">
            没有已登录的账号
          </div>
        </div>

        <!-- 底部操作 -->
        <div class="am-footer">
          <button
            v-if="auth.isConnected"
            type="button"
            class="am-btn am-btn--danger-outline"
            @click="onLogoutAndRemove"
          >
            <LogOut :size="14" />
            退出并移除当前账号
          </button>
          <button
            type="button"
            class="am-btn am-btn--primary"
            @click="showAddForm = !showAddForm"
          >
            <UserPlus :size="14" />
            {{ showAddForm ? '收起' : '添加新账号' }}
          </button>
        </div>

        <!-- 添加新账号表单 -->
        <div v-if="showAddForm" class="am-add-form">
          <!-- 平台选择 tab -->
          <div class="am-add-field">
            <label class="am-add-label">选择平台</label>
            <div class="am-add-platform-tabs">
              <button
                v-for="p in addPlatforms"
                :key="p.value"
                type="button"
                class="am-add-platform-tab"
                :class="{ 'am-add-platform-tab--active': addPlatform === p.value }"
                :disabled="addLoading"
                @click="addPlatform = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </div>

          <!-- Gitea 才显示地址输入框 -->
          <div v-if="addPlatform === 'gitea'" class="am-add-field">
            <label class="am-add-label">gitea 地址</label>
            <input
              v-model="newGiteaUrl"
              type="url"
              class="am-add-input"
              placeholder="http://127.0.0.1:3000"
              :disabled="addLoading"
            />
          </div>

          <div v-if="addPlatform === 'github'" class="am-gh-guide">
            <p class="am-gh-guide__title">{{ GITHUB_CLI_REQUIRED_MESSAGE }}</p>
            <p class="am-gh-guide__body">
              {{ GITHUB_CLI_REQUIRED_HINT }}
              <a :href="GITHUB_CLI_INSTALL_URL" target="_blank" rel="noopener noreferrer">
                {{ GITHUB_CLI_INSTALL_LABEL }}
              </a>
            </p>
          </div>

          <div class="am-add-field">
            <label class="am-add-label">个人访问令牌</label>
            <div class="am-add-input-wrap">
              <input
                v-model="newToken"
                :type="showNewToken ? 'text' : 'password'"
                class="am-add-input"
                placeholder="粘贴令牌（至少 8 个字符）"
                :disabled="addLoading"
                @keydown.enter.prevent="onAddAccount"
              />
              <button
                type="button"
                class="am-add-toggle"
                @click="showNewToken = !showNewToken"
              >
                {{ showNewToken ? '隐藏' : '显示' }}
              </button>
            </div>
            <p class="am-add-hint">
              <template v-if="addPlatform === 'github'">
                不知道怎么获取？
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noopener noreferrer"
                  >GitHub → Settings → Developer settings → Personal access tokens</a
                >（classic PAT 勾选 <code>repo</code>）
              </template>
              <template v-else>
                不知道怎么获取？去 gitea 的
                <a
                  href="https://docs.gitea.com/usage/api-usage#generating-an-access-token"
                  target="_blank"
                  rel="noopener noreferrer"
                  >设置 → 应用 → 生成令牌</a>
              </template>
            </p>
          </div>
          <div v-if="addError" class="am-add-error">{{ addError }}</div>
          <button
            type="button"
            class="am-btn am-btn--primary am-add-submit"
            :disabled="addLoading"
            @click="onAddAccount"
          >
            <Check :size="14" />
            {{ addLoading ? '连接中…' : '连接' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.am-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-overlay, rgba(0,0,0,0.45));
  z-index: var(--z-modal-overlay, 100);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  animation: amFadeIn 150ms ease-out;
}

.am-dialog {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-lg);
  width: min(480px, 100%);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  animation: amSlideUp 180ms cubic-bezier(0.16,1,0.3,1);
}

.am-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-4) var(--space-3);
}
.am-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
}
.am-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.am-close:hover { background: var(--color-bg-hover); color: var(--color-text); }

/* 账号列表 */
.am-list {
  padding: 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.am-account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  transition: background 0.15s;
}
.am-account--current {
  border-color: var(--color-primary);
  background: var(--color-primary-soft, rgba(116,184,48,0.06));
}
.am-account__info {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.am-account__avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.am-account__avatar-fallback {
  width: 28px;
  height: 28px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.am-account__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.am-account__login {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.am-account__url {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.am-account__actions {
  display: flex;
  gap: var(--space-1);
  flex-shrink: 0;
}
.am-empty {
  text-align: center;
  padding: var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--font-sm);
}

/* 底部 */
.am-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-divider);
  margin-top: var(--space-2);
}

/* 按钮 */
.am-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text);
}
.am-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.am-btn--ghost { border-color: var(--color-divider); }
.am-btn--ghost:hover:not(:disabled) { background: var(--color-bg-hover); }
.am-btn--danger { color: var(--color-danger); }
.am-btn--danger:hover:not(:disabled) { background: rgba(220,38,38,0.08); }
.am-btn--danger-outline { border-color: var(--color-danger); color: var(--color-danger); }
.am-btn--danger-outline:hover:not(:disabled) { background: rgba(220,38,38,0.08); }
.am-btn--primary { background: var(--color-primary); color: var(--color-text-inverse, #fff); border: none; }
.am-btn--primary:hover:not(:disabled) { background: var(--color-primary-hover); }

/* 添加表单 */
.am-add-form {
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--color-divider);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.am-add-field { display: flex; flex-direction: column; gap: var(--space-1); }
.am-add-label { font-size: var(--font-xs); color: var(--color-text-muted); }
.am-add-hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  line-height: 1.5;
  margin-top: 2px;
}
.am-add-hint a {
  color: var(--color-primary);
  text-decoration: underline;
}
.am-add-hint code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  padding: 1px 4px;
  background: var(--color-bg-hover);
  border-radius: 3px;
  color: var(--color-text);
}
.am-gh-guide {
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--color-primary) 36%, var(--color-divider));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.am-gh-guide__title {
  margin: 0 0 2px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--color-text);
}
.am-gh-guide__body {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.am-gh-guide__body a {
  color: var(--color-primary);
  text-decoration: underline;
  white-space: nowrap;
}
/* 平台选择 tab(跟 AuthView 视觉对齐) */
.am-add-platform-tabs {
  display: flex;
  gap: 6px;
}
.am-add-platform-tab {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-divider);
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 150ms ease;
}
.am-add-platform-tab:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-text);
}
.am-add-platform-tab--active {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.am-add-platform-tab:disabled { opacity: 0.5; cursor: not-allowed; }
.am-add-input {
  height: 32px;
  padding: 0 var(--space-3);
  font-size: var(--font-sm);
  color: var(--color-text);
  /* v1.6.1 改 --color-bg-elevated（白），跟弹窗主面板同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 跟弹窗白底对比过强 */
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  outline: none;
}
.am-add-input:focus { border-color: var(--color-primary); }
.am-add-input:disabled { opacity: 0.6; }
.am-add-input-wrap { position: relative; display: flex; }
.am-add-input-wrap .am-add-input { flex: 1; padding-right: 56px; }
.am-add-toggle {
  position: absolute; right: 4px; top: 4px; bottom: 4px;
  padding: 0 var(--space-2);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  background: transparent; border: none; border-radius: var(--radius-sm);
  cursor: pointer;
}
.am-add-toggle:hover { color: var(--color-text); }
.am-add-error {
  font-size: var(--font-sm);
  color: var(--color-danger);
  padding: var(--space-2);
  background: rgba(220,38,38,0.08);
  border-radius: var(--radius-sm);
}
.am-add-submit { align-self: flex-start; }

.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

@keyframes amFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes amSlideUp { from { transform: translateY(8px) scale(0.98); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
</style>
