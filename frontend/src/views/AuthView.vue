<script setup lang="ts">
/**
 * AuthView —— PAT 输入 + 连接
 *
 * 设计（AGENTS §8.2 鉴权铁律 + OVERRIDE §本项目专属规则 #1）：
 *   - 输入 gitea URL + 个人访问令牌 → 调 window.api.auth.connect
 *   - token 在传输到 main 端后立刻进 keychain，**不**在 store / localStorage / cookie 留底
 *   - 错误展示走"人话"：从 IpcError.hint + 类别前缀（ipc-client.ts 已统一处理）
 *   - UI 文本零术语：不说"Personal Access Token" 而说"个人访问令牌"（hover 解释怎么生成）
 *
 * 交互：
 *   - URL 输入框：placeholder 给出示例
 *   - Token 输入框：type="password"（遮蔽），不显示明文
 *   - "如何获取令牌"链接：跳 gitea 设置页（v1 用 anchor，新窗口打开）
 *   - 提交中：按钮禁用 + 显示加载文案
 *   - 成功后：跳 /board（路由 push）
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Eye, EyeOff, Folder, KeyRound, LogIn, ShieldCheck } from 'lucide-vue-next';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import { commitsGitgraphGetWorkspace, commitsGitgraphSetWorkspace, getIpcClient } from '@renderer/lib/ipc-client';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

/**
 * v1.5.3 工作区路径：默认跨平台 `~/.gitea-kanban/workspace`（macOS/Linux = $HOME/.gitea-kanban/workspace；
 * Windows = %USERPROFILE%\.gitea-kanban\workspace）。
 *
 * 计算：
 *   - 启动期 / 切到 AuthView 时 main 端 initWorkspace 已 lazy 设默认到 prefs
 *   - 这里读 prefs 取 cwd（用户之前设过的或默认）
 *   - 用户改 → 提交时 setWorkspace
 */
const DEFAULT_WORKSPACE_LABEL =
  '~/.gitea-kanban/workspace（默认；macOS/Linux = $HOME/.gitea-kanban/workspace；Windows = %USERPROFILE%\\.gitea-kanban\\workspace）';

/**
 * v1.4 任务 #auth-prefill-localhost:
 * 默认本地测试地址 → 用户只需填 token 即可快速测。
 *
 * 行为：
 *   - 首次进入 AuthView + 还没连上 → 自动填 http://127.0.0.1:3000
 *   - 用户可改:地址框不锁(锁了反而添堵,自托管环境要换)
 *   - 自动 focus 到 token 输入框（输入完直接 ⏎ 提交）
 *   - placeholder 同步改为提示"自托管/自定义地址"
 *   - 已经在持久化 prefs 里看到 giteaUrl 时保留(v1.4 起 prefs 里有 url),
 *     走 restoreLastSelected 的 prefs 路径 —— AuthView 本身不读 prefs(职责单一)
 */
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:3000';

/** v2 多平台：当前选择的平台 */
const selectedPlatform = ref<'gitea' | 'github'>('gitea');

/** 平台选项 */
const platforms = [
  { value: 'gitea' as const, label: 'Gitea（自托管）', hint: '连接自托管 Gitea 实例' },
  { value: 'github' as const, label: 'GitHub', hint: '连接 GitHub（首期仅 Git Graph）' },
];

const giteaUrl = ref(DEFAULT_LOCAL_URL);
const token = ref('');
const workspacePath = ref(''); // v1.5.3：用户配置的应用工作区根目录
const showToken = ref(false);
const localError = ref<string | null>(null);
const tokenInputEl = ref<HTMLInputElement | null>(null);

/** 启动期预填 workspace 默认值 */
(async (): Promise<void> => {
  try {
    const resp = await commitsGitgraphGetWorkspace();
    workspacePath.value = resp.cwd;
  } catch {
    // getWorkspace lazy init 失败 → 留空，用户提交时会回退到 main 端默认
  }
})();

const submitting = computed(() => auth.loading);
const hasAnyError = computed(() => Boolean(localError.value) || Boolean(auth.error));

/** 提交时优先级：local validation > auth.error（来自 main 端） */
const errorMessage = computed(() => {
  if (localError.value) return localError.value;
  if (auth.error) return auth.error.messageText;
  return null;
});

const errorHint = computed(() => auth.error?.hint ?? null);

onMounted(async () => {
  // 拉一次状态（如果已经接好直接跳走）
  if (auth.accounts.length === 0) {
    try {
      await auth.refreshStatus();
    } catch {
      /* ignore */
    }
  }
  if (auth.isConnected) {
    goNext();
    return;
  }
  // 未连接:token 框自动 focus —— 用户粘贴 token 后直接 ⏎ 提交,无需点输入框
  await nextTick();
  tokenInputEl.value?.focus();
});

function validateUrl(url: string): string | null {
  if (selectedPlatform.value === 'github') {
    // GitHub 固定地址，跳过校验
    return null;
  }
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

function validateToken(t: string): string | null {
  if (!t.trim()) return '请输入个人访问令牌';
  if (t.trim().length < 8) return '令牌长度至少 8 个字符';
  return null;
}

async function onSubmit(): Promise<void> {
  localError.value = null;
  auth.clearError();

  // GitHub 固定地址
  const urlToConnect = selectedPlatform.value === 'github'
    ? 'https://github.com'
    : giteaUrl.value.trim();

  const urlErr = validateUrl(urlToConnect);
  if (urlErr) {
    localError.value = urlErr;
    return;
  }
  const tokenErr = validateToken(token.value);
  if (tokenErr) {
    localError.value = tokenErr;
    return;
  }

  // v1.5.3：先 setWorkspace（用户可能改过路径）→ 再 connect
  // v2 迁移说明：setWorkspace 在 shim 层是 stub 模式（Go 端 OnStartup 已建默认 workspace）
  // → 这里只识别"已实现的错误"才阻断；"未实现"错误降级为 warn 不阻断连接
  try {
    if (workspacePath.value.trim()) {
      await commitsGitgraphSetWorkspace({ cwd: workspacePath.value.trim() });
    }
  } catch (e) {
    const err = e as { code?: string; messageText?: string; message?: string; hint?: string };
    const raw = err.messageText ?? err.message ?? String(e) ?? 'workspace 设置失败';
    // v2 迁移期 shim 可能返 "尚未实现"——仅 warn，不阻断登录
    if (raw.includes('尚未实现') || raw.includes('not implemented') || err.code === 'internal') {
      console.warn('[gitea-kanban] setWorkspace stub warning:', raw);
      // 继续走 connect（Go 端默认 workspace 已 OK）
    } else {
      localError.value = `工作区路径无效：${raw}`;
      return;
    }
  }

  try {
    await auth.connect(urlToConnect, token.value.trim());
    showToast({
      type: 'success',
      message: '连接成功',
      description: `欢迎，${auth.currentUser?.login ?? ''}`,
    });
    goNext();
  } catch {
    // 错误已存到 auth.error，由模板渲染
  }
}

function goNext(): void {
  const from = route.query.from;
  const target = typeof from === 'string' && from.startsWith('/') ? from : '/board';
  void router.push(target);
}
</script>

<template>
  <div class="auth">
    <div class="auth__card">
      <header class="auth__header">
        <div class="auth__logo" aria-hidden="true">
          <ShieldCheck :size="32" :stroke-width="1.5" />
        </div>
        <h1 class="auth__title">连接代码仓库</h1>
        <p class="auth__subtitle">
          选择平台并输入个人访问令牌。
          <br />
          令牌只在本机加密保存，不会上传到任何地方。
        </p>
      </header>

      <form class="auth__form" @submit.prevent="onSubmit">
        <!-- v2 多平台选择 -->
        <div class="auth__field">
          <label class="auth__label">选择平台</label>
          <div class="auth__platform-tabs">
            <button
              v-for="p in platforms"
              :key="p.value"
              type="button"
              class="auth__platform-tab"
              :class="{ 'auth__platform-tab--active': selectedPlatform === p.value }"
              :disabled="submitting"
              @click="selectedPlatform = p.value"
            >
              {{ p.label }}
            </button>
          </div>
          <p class="auth__hint">
            {{ platforms.find(p => p.value === selectedPlatform)?.hint }}
          </p>
        </div>

        <!-- Gitea: 显示地址输入框；GitHub: 固定地址 -->
        <div v-if="selectedPlatform === 'gitea'" class="auth__field">
          <label class="auth__label" for="gitea-url">gitea 地址</label>
          <input
            id="gitea-url"
            v-model="giteaUrl"
            type="url"
            class="auth__input"
            placeholder="自托管 gitea:https://git.example.com/gitea/"
            autocomplete="url"
            spellcheck="false"
            :disabled="submitting"
          />
          <p class="auth__hint">默认本地测试地址 http://127.0.0.1:3000；自托管 gitea 多部署在子路径，例如 https://git.example.com/gitea/</p>
        </div>

        <div class="auth__field">
          <label class="auth__label" for="gitea-token">个人访问令牌</label>
          <div class="auth__input-wrap">
            <input
              id="gitea-token"
              ref="tokenInputEl"
              v-model="token"
              :type="showToken ? 'text' : 'password'"
              class="auth__input auth__input--with-icon"
              placeholder="粘贴令牌（至少 8 个字符）"
              autocomplete="off"
              spellcheck="false"
              :disabled="submitting"
            />
            <button
              type="button"
              class="auth__toggle"
              :aria-label="showToken ? '隐藏令牌' : '显示令牌'"
              :title="showToken ? '隐藏令牌' : '显示令牌'"
              @click="showToken = !showToken"
            >
              <component :is="showToken ? EyeOff : Eye" :size="16" :stroke-width="2" />
            </button>
          </div>
          <p class="auth__hint">
            不知道怎么获取？去 gitea 的
            <a
              href="https://docs.gitea.com/usage/api-usage#generating-an-access-token"
              target="_blank"
              rel="noopener noreferrer"
              >设置 → 应用 → 生成令牌</a
            >
            （需要勾选仓库、议题、用户的读写权限）
          </p>
        </div>

        <div class="auth__field">
          <label class="auth__label" for="workspace-path">
            <Folder :size="13" :stroke-width="2" />
            应用工作区（git clone 仓库的本地根目录）
          </label>
          <input
            id="workspace-path"
            v-model="workspacePath"
            type="text"
            class="auth__input"
            :placeholder="DEFAULT_WORKSPACE_LABEL"
            spellcheck="false"
            :disabled="submitting"
          />
          <p class="auth__hint">
            仓库会按 <code>${'${workspacePath}'}/repos/${'${owner}'}__${'${repo}'}.git</code> 路径 clone。
            不填则用默认 {{ DEFAULT_WORKSPACE_LABEL }}。
          </p>
        </div>

        <div v-if="hasAnyError" class="auth__error" role="alert">
          <KeyRound :size="16" :stroke-width="2" aria-hidden="true" />
          <div>
            <p class="auth__error-message">{{ errorMessage }}</p>
            <p v-if="errorHint" class="auth__error-hint">{{ errorHint }}</p>
          </div>
        </div>

        <button type="submit" class="auth__submit" :disabled="submitting">
          <LogIn :size="16" :stroke-width="2" aria-hidden="true" />
          <span>{{ submitting ? '正在连接…' : '连接' }}</span>
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
/* v2 多平台选择 tab */
.auth__platform-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.auth__platform-tab {
  flex: 1;
  padding: 10px 16px;
  border: 1px solid var(--color-border, #2d333f);
  background: transparent;
  color: var(--color-text-secondary, #94a3b8);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 150ms ease;
}

.auth__platform-tab:hover:not(:disabled) {
  border-color: var(--color-primary, #74b830);
  color: var(--color-text-primary, #c5d4dd);
}

.auth__platform-tab--active {
  border-color: var(--color-primary, #74b830);
  color: var(--color-primary, #74b830);
  background: color-mix(in srgb, var(--color-primary, #74b830) 8%, transparent);
}

.auth__platform-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.auth {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  overflow-y: auto;
}

.auth__card {
  width: 100%;
  max-width: 440px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.auth__header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.auth__logo {
  color: var(--color-primary);
  margin-bottom: var(--space-1);
}

.auth__title {
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--color-text);
}

.auth__subtitle {
  font-size: var(--font-sm);
  color: var(--color-text-secondary);
  line-height: var(--line-relaxed);
}

.auth__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.auth__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.auth__label {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--color-text);
}

.auth__input {
  width: 100%;
}

.auth__input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.auth__input--with-icon {
  padding-right: 40px;
}

.auth__toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 6px;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.auth__toggle:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
}

.auth__hint {
  font-size: var(--font-xs);
  color: var(--color-text-muted);
  line-height: var(--line-base);
}

.auth__hint a {
  color: var(--color-primary);
  text-decoration: underline;
}

.auth__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--color-danger);
  color: var(--color-text);
}

.auth__error-message {
  font-size: var(--font-sm);
  font-weight: 500;
  margin: 0 0 2px 0;
}

.auth__error-hint {
  font-size: var(--font-xs);
  color: var(--color-text-secondary);
  margin: 0;
}

.auth__submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 40px;
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  font-weight: 500;
  cursor: pointer;
  box-shadow:
    0 0 0 1px var(--color-primary-active),
    0 0 16px var(--color-primary-glow);
  transition:
    background var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}

.auth__submit:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.auth__submit:active:not(:disabled) {
  background: var(--color-primary-active);
  transform: translateY(1px);
}

.auth__submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  box-shadow: none;
}
</style>
