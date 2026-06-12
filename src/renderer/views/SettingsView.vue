<script setup lang="ts">
/**
 * SettingsView —— 用户偏好设置面板
 *
 * v1.1.2 起加 "外观" 分组（入口 2，tech-refine §15.1）：
 *   - 3 主题单选（A 暗 / C 暗 / 浅色）
 *   - onChange 立即调 uiStore.applyTheme —— CSS 150ms 过渡 + 异步 IPC 持久化
 *   - 不做保存按钮（点选即生效），区别于 polling interval（数值输入需要手动保存）
 *
 * polling interval 分组保持 v1 行为：
 *   - 默认 5 min
 *   - 30s ~ 30 min
 *   - 改完立即生效（App.vue watch 监听 + 重启 timer）
 *
 * 设计：
 *   - 不做 i18n（v1 硬编码中文）
 *   - 数值输入框 + 步进按钮，避免自由输入整数错误
 *   - 外观分组用 `.settings-group`（与 polling 的 `.settings__section` BEM 解耦）
 */
import { computed, ref } from 'vue';
import { useSettingsStore, SETTINGS_LIMITS } from '@renderer/stores/settings';
import { useUiStore, THEME_DISPLAY_NAME, type Theme } from '@renderer/stores/ui';
import { showToast } from '@renderer/lib/toast';

const settings = useSettingsStore();
const ui = useUiStore();

/** 外观分组 3 选 1（与 tech-refine §14 token 矩阵 + §15.1 单选规格同步） */
const themeOptions: ReadonlyArray<{ value: Theme; label: string; desc: string }> = [
  { value: 'A-dark', label: THEME_DISPLAY_NAME['A-dark'], desc: '夜间长时间使用推荐' },
  { value: 'C-dark', label: THEME_DISPLAY_NAME['C-dark'], desc: '专业工具风' },
  { value: 'light', label: THEME_DISPLAY_NAME['light'], desc: '白天或打印场景' },
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
</style>
