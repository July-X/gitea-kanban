<script setup lang="ts">
/**
 * SettingsView —— 用户偏好设置面板
 *
 * 当前只装 polling interval（仓库列表自动刷新间隔）：
 *   - 默认 5 min
 *   - 30s ~ 30 min
 *   - 改完立即生效（App.vue watch 监听 + 重启 timer）
 *
 * 设计：
 *   - 单列表项 + 单按钮（保存）
 *   - 不做 i18n（v1 硬编码中文）
 *   - 数值输入框 + 步进按钮，避免自由输入整数错误
 */
import { computed, ref } from 'vue';
import { useSettingsStore, SETTINGS_LIMITS } from '@renderer/stores/settings';
import { showToast } from '@renderer/lib/toast';

const settings = useSettingsStore();

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
          也可以直接输入秒数：<br />
          <input
            type="number"
            class="settings__input settings__input--inline"
            :value="Math.round(draftMs / 1000)"
            min="30"
            max="1800"
            @change="onSecondsChange"
          /> 秒
          <br />
          <span class="settings__hint--muted">
            （范围：30 秒 ~ 30 分钟；当前设置保存在浏览器本地，不跨设备同步）
          </span>
        </p>
      </div>

      <button type="button" class="settings__save" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
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
</style>
