<script setup lang="ts">
/**
 * App.vue —— 根 SFC
 *
 * 设计（AGENTS §5.2 + AGENTS §5.2 frontend agent）：
 *   - 单根 <AppShell>（NavRail + 主区 + StatusBar 三件套）
 *   - 全局 <Toast /> 挂在 body 层（Teleport 出去）
 *   - 不在 App 层做业务（业务在 view + store 里）
 *   - 被动轮询：每 N 分钟（settings 可配，默认 5min）拉一次仓库列表
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import AppShell from '@renderer/components/AppShell.vue';
import Toast from '@renderer/components/Toast.vue';
import DevAnnotatePopover from '@renderer/components/DevAnnotatePopover.vue';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useSettingsStore } from '@renderer/stores/settings';

/**
 * 是否 dev 模式 —— Vite 编译期常量
 * 生产构建里直接变 false，<DevAnnotatePopover v-if="isDev" /> 整段被消除
 */
const isDev = import.meta.env.DEV;

const auth = useAuthStore();
const repo = useRepoStore();
const settings = useSettingsStore();

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 启动 / 重新设置 interval 用的内部函数 */
function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!auth.isConnected) return; // 未连接就不拉
    void repo.loadRepos('', true)
      .then(() => repo.refreshClonedStatus())
      .catch(() => {
        /* 静默：用户已经看到错误提示，轮询触发的错误不再弹 toast */
      });
  }, settings.pollingIntervalMs);
}

onMounted(async () => {
  // 启动时拉一次连接状态（让路由守卫能正确分流）
  try {
    await auth.refreshStatus();
  } catch {
    /* 错误已存到 auth.error，由 StatusBar 提示 */
  }
  // 启动被动轮询（连接后才有效，函数内已守卫）
  startPolling();
  // v1.4 任务 #statusbar-persist:启动期尝试恢复上次选择的仓库,失败再走引导
  // 注:此处只恢复 currentProject;不自动 loadBoard —— 避免启动期一堆 IPC 并发,
  // 用户点导航到具体 view 时由各 view 自行 load(更可控)
  await tryRestoreOrPromptRepoGuide();
  // v2.6:订阅后端 git:sync:progress 事件 → 写入 repo.progressByRepo
  // StatusBar 行末按钮下方进度条的数据源
  const offProgress = repo.initProgressEvents();
  onBeforeUnmount(() => {
    offProgress();
  });
});

// 用户改了 polling interval → 重启 timer
watch(
  () => settings.pollingIntervalMs,
  () => startPolling(),
);

/**
 * v1.4 任务 #statusbar-picker + #statusbar-persist
 *
 * 监听 isConnected 边沿:
 *   - false → true 切换 + 当前还没选仓库 → 拉一次仓库列表 → 尝试恢复 → 失败再引导
 *   - 启动期 tryRestoreOrPromptRepoGuide 走相同路径
 */
let connectedFromDisconnect = !auth.isConnected;
watch(
  () => auth.isConnected,
  async (now, prev) => {
    if (now && !prev) {
      connectedFromDisconnect = true;
    }
    if (now && connectedFromDisconnect && !repo.currentProject) {
      connectedFromDisconnect = false;
      try {
        if (repo.repos.length === 0) {
          await repo.loadRepos('', true);
          await repo.refreshClonedStatus();
        }
      } catch {
        /* 错误已在 repo.error,StatusBar 提示 */
      }
      await tryRestoreOrPromptRepoGuide(/* alreadyLoadedRepos */ true);
    }
  },
);

/**
 * v1.4 任务 #statusbar-persist + #statusbar-picker
 *
 * 启动期 / isConnected 边沿 共用入口:
 *   1. 未连接 → 直接 return（StatusBar 已显示"未连接"chip,用户得先去 /auth 连）
 *   2. 已选仓库 → 直接 return
 *   3. 尝试 restoreLastSelected:
 *      - 成功拿到 { owner, name, projectId } + 当前 repos[] 里有 fullName 匹配 →
 *        用 repo.addProject（如果还没 project）+ repo.selectProject → done
 *        （uuid 沿用 prefs 里的,但 addProject 返回的才是真 uuid;两者用同一个 fullName,
 *         main 端 addProject 幂等 → 拿到的 uuid 跟 prefs 一致,后续 IPC 不出问题）
 *      - 任何环节失败（无持久化 / giteaUrl 不匹配 / 仓库已被删） → fall through 引导
 *   4. 引导:repo.guideOnConnect = true → StatusBar watch 触发 picker 打开
 *
 * @param alreadyLoadedRepos true 表示仓库列表已拉过(避免重复 loadRepos)
 */
async function tryRestoreOrPromptRepoGuide(alreadyLoadedRepos = false): Promise<void> {
  if (!auth.isConnected || repo.currentProject) return;

  // 兜底拉一次仓库列表（callers 可传 alreadyLoadedRepos=true 跳过）
  if (!alreadyLoadedRepos && repo.repos.length === 0) {
    try {
      await repo.loadRepos('', true);
      await repo.refreshClonedStatus();
    } catch {
      /* 错误已在 repo.error */
    }
  }

  // 尝试从持久化恢复
  const restored = await repo.restoreLastSelected(auth.currentGiteaUrl);
  if (restored) {
    const matched = repo.repos.find(
      (r) => r.owner === restored.owner && r.name === restored.name,
    );
    if (matched) {
      try {
        // addProject 幂等（已加入过也走同一路径）→ 拿到真 uuid 后 selectProject
        const project = await repo.addProject({ owner: restored.owner, name: restored.name });
        repo.selectProject(project);
        // 恢复成功 → 重新持久化一次（addProject 内部 refresh repos 后 isProject 标记变了,
        // 这次持久化把"已加入"标签也写进 prefs,后续 restore 更准确）
        void repo.persistLastSelected(matched, project, auth.currentGiteaUrl);
        return; // 跳过引导
      } catch {
        /* addProject 失败 → fall through 引导 */
      }
    }
  }

  // 恢复失败 → 引导选仓库
  repo.guideOnConnect = true;
}

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <AppShell />
  <Toast />
  <!--
    Dev 模式注解 popover（v1.1.3 · task #42）
    - 仅 dev 显示（Vite 把 isDev 编译成 false，生产 v-if 消除）
    - 内部订阅 lib/dev-annotate 的 annotation ref，无注解时啥也不渲染
  -->
  <DevAnnotatePopover v-if="isDev" />
  <!--
    v1.6 移除 HUD 装饰元素：corner-dots（窗口顶角 4×4 装饰点阵）已全删
    v1.1.2 引入，v1.6 跟随 Minimalism + Functional Density 方向调整删除
  -->
</template>
