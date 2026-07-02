/**
 * repo store —— 当前仓库上下文 + 仓库列表
 *
 * 设计（AGENTS §5.2 + AGENTS §5.2 frontend agent（Pinia store））：
 *   - 仓库列表从 main 端拉（gitea API + 本机 project 标记聚合）
 *   - "当前仓库"是仓库视图的上下文（看板/时间轴都基于它）
 *   - **不**做仓库分类（starred/archived/owned 等等的过滤放 UI 层）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  commitsGitgraphCloneRepo,
  commitsGitgraphIsRepoCloned,
  commitsGitgraphPull,
  reposAddProject,
  reposList,
  reposRemoveProject,
  getIpcClient,
} from '@renderer/lib/ipc-client';
import { normalizeError } from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { ListReposResp, RepoDto, RepoProjectDto } from '@renderer/types/dto';
import type { SyncProgress, GitSyncProgressPayload } from '@renderer/types/sync-progress';
import { GitSyncProgressEvent } from '@renderer/types/sync-progress';
import { useAuthStore } from '@renderer/stores/auth';
import { useGlobalLoadingStore } from '@renderer/stores/global-loading';

/**
 * v1.4 任务 #statusbar-persist：上次选择的仓库持久化 key
 *
 * 走 user.prefs 通用通道（theme / navrail.collapsed / repo.last.selected 同一管线）
 * value schema:
 *   {
 *     giteaUrl: string,  // 检测「换 gitea 账号」→ 不一致则视为失效
 *     owner:     string,
 *     name:      string,
 *     projectId: string, // RepoProjectDto 的真 uuid（精确选回，避免 fullName 撞库）
 *   }
 *
 * localStorage 同步缓存 key（启动期 0 闪烁，跟 navCollapsed 同模式）
 */
const REPO_LAST_PREF_KEY = 'repo.last.selected';
const REPO_LAST_STORAGE_KEY = 'gitea-kanban.repoLast';

/** 持久化 value 的窄类型 —— 读 prefs 时容错校验,失败返 null(等于"没选过") */
interface RepoLastPrefValue {
  giteaUrl: string;
  owner: string;
  name: string;
  projectId: string;
}

function isRepoLastPrefValue(v: unknown): v is RepoLastPrefValue {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.giteaUrl === 'string' &&
    typeof o.owner === 'string' &&
    typeof o.name === 'string' &&
    typeof o.projectId === 'string' &&
    o.giteaUrl.length > 0 &&
    o.owner.length > 0 &&
    o.name.length > 0 &&
    o.projectId.length > 0
  );
}

export const useRepoStore = defineStore('repo', () => {
  // ===== state =====
  const repos = ref<RepoDto[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  /**
   * 权威当前 project（**uuid 源** —— 所有 IPC 端点要的就是这个）
   *
   * 历史（2026-06-11 bug 修复）：
   * - 旧实现 currentProjectId 直接存 fullName，IPC 端点（board.columns.list / branches.list 等）
   *   拿 fullName 去 sqlite 查 repo_projects 主键 = uuid → 全部 not_found
   * - 修复：currentProject 存 RepoProjectDto；currentProjectId 退化成 computed 返 uuid；
   *   currentRepo 仍用 fullName 查（UI 反查 RepoDto 不变）
   * - selectProject 接受 string 时兼容两种语义：先查 projects[] 找 uuid（fullName 匹配），
   *   找不到再当 uuid 直接存（route 跳转/老 caller）。新代码推荐传 RepoProjectDto
   */
  const currentProject = ref<RepoProjectDto | null>(null);
  const loading = ref(false);
  const error = ref<UserFacingError | null>(null);

  // ===== getters =====
  /** 给 IPC 用的 uuid —— 看板/时间轴/分支/合并的 projectId 参数都走这个 */
  const currentProjectId = computed<string | null>(() => currentProject.value?.id ?? null);
  /** 给 UI 反查 RepoDto（侧栏显示/高亮）用的 fullName —— 兼容 caller 传 fullName 时仍能 find */
  const currentRepo = computed<RepoDto | null>(() => {
    const fullName = currentProject.value
      ? `${currentProject.value.owner}/${currentProject.value.name}`
      : null;
    if (!fullName) return null;
    return repos.value.find((r) => r.fullName === fullName) ?? null;
  });
  /** 已加为 project 的仓库（isProject=true） */
  const projects = computed<RepoDto[]>(() => repos.value.filter((r) => r.isProject));

  // ===== actions =====

  /**
   * 拉取当前账号可访问的仓库列表
   * @param query 搜索关键词（gitea API 支持 name/description 模糊匹配）
   * @param reset 是否重置列表（默认 true，传 false = 翻页追加）
   */
  async function loadRepos(query = '', reset = true): Promise<void> {
    const auth = useAuthStore();
    if (!auth.accounts[0]) {
      error.value = {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何 gitea 实例',
        hint: '请先在"连接"页填入 gitea URL 和令牌',
        recoverable: true,
      };
      return;
    }
    const accountId = auth.accounts[0].id;
    loading.value = true;
    useGlobalLoadingStore().show('repo');
    error.value = null;
    try {
      const resp = (await reposList({
        giteaAccountId: accountId,
        query: query || undefined,
        limit: 50,
        page: 1,
      })) as ListReposResp;
      if (reset) {
        repos.value = resp.items;
      } else {
        repos.value = [...repos.value, ...resp.items];
      }
      total.value = resp.total;
      hasMore.value = resp.hasMore;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  /**
   * 选中当前 project（**uuid 源**）
   *
   * 只接受 RepoProjectDto | null —— 强类型保证 IPC 拿到真 uuid，不再有 fullName 误用空间。
   * 老 caller（传 fullName string）已迁移：调 addProject() 拿到 RepoProjectDto 再传进来。
   *
   * 历史（2026-06-11 bug 修复）：
   * 旧实现 selectProject 接受 string + currentProjectId 直接存 fullName，导致
   * 所有 IPC 端点（board.columns.list / branches.list / etc.）拿 fullName 去
   * sqlite 查 repo_projects 主键（uuid）→ 全部 not_found
   */
  function selectProject(project: RepoProjectDto | null): void {
    currentProject.value = project;
  }

  /**
   * 把仓库加为本机 project（加入看板）
   *
   * 修复（2026-06-11）：接收后端返的 RepoProjectDto（uuid 源），**自动选中新加的 project**。
   * 旧实现丢了返回值，uuid 在前端就消失了 → 看板 IPC 全部 not_found。
   */
  async function addProject(args: { owner: string; name: string }): Promise<RepoProjectDto> {
    const auth = useAuthStore();
    if (!auth.accounts[0]) {
      throw {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何 gitea 实例',
        hint: '请先连接 gitea',
        recoverable: true,
      } satisfies UserFacingError;
    }
    const accountId = auth.accounts[0].id;
    loading.value = true;
    useGlobalLoadingStore().show('repo');
    error.value = null;
    try {
      const project = (await reposAddProject({
        giteaAccountId: accountId,
        ...args,
      })) as RepoProjectDto;
      // 刷新列表让 isProject 标记更新
      await loadRepos('', true);
      // 选中新加的 project（uuid 源）
      currentProject.value = project;
      return project;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  /**
   * 取消本机 project 标记（**不**删远端仓库）
   *
   * 接受 fullName 或 uuid（兼容老 caller）。内部解析成 uuid 再调 IPC。
   * 后端 cacheRemoveProject 用 `eq(repoProjects.id, projectId)` 删，必须 uuid。
   */
  async function removeProject(projectId: string): Promise<void> {
    const uuid = resolveProjectUuid(projectId);
    if (!uuid) {
      // 找不到对应 project —— 静默成功（cache 端是幂等的）
      return;
    }
    loading.value = true;
    useGlobalLoadingStore().show('repo');
    error.value = null;
    try {
      await reposRemoveProject({ projectId: uuid });
      if (currentProject.value?.id === uuid) {
        currentProject.value = null;
      }
      await loadRepos('', true);
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  /**
   * 内部 helper：把 caller 传的 fullName / uuid 解析成真 uuid
   * - 当前选中的 project（fullName 或 uuid 匹配）→ 用 currentProject.id
   * - projects[] 里的 RepoDto（按 fullName 找）→ **没有真 uuid**（RepoDto 不带 projectId 字段）
   *   这种情况下**返回 null** —— caller 应当用 addProject 的返回值走
   *
   * 已知限制：projects[] 来自 JOIN isProject=true 的 RepoDto，没 projectId（uuid）字段
   * 这是 schema 设计权衡：UI 列的"已加为项目"用 fullName 即可，不需要 uuid
   * 真 uuid 只能从 addProject 返回 / currentProject.id 来
   */
  function resolveProjectUuid(input: string): string | null {
    if (
      currentProject.value &&
      (currentProject.value.id === input ||
        `${currentProject.value.owner}/${currentProject.value.name}` === input)
    ) {
      return currentProject.value.id;
    }
    return null;
  }

  function clearError(): void {
    error.value = null;
  }

  /**
   * v1.4 任务 #statusbar-picker：
   * 登录成功后,如果还没选仓库,提示用户从下拉菜单选一个 —— "全局保存,后续所有操作都针对这个仓库"
   * 实现:App.vue 监听 auth.isConnected 边沿变 true + repo.currentProject == null → set true
   * StatusBar 监听此 ref 变 true → 自动打开 picker,选完清回 false
   *
   * 跨 store 协调不引 bus/事件:用 repo store 的一个普通 ref 当标志位最轻
   * (不存 localStore,纯运行时状态,刷新即丢)
   */
  const guideOnConnect = ref(false);
  function consumeGuideOnConnect(): void {
    guideOnConnect.value = false;
  }

  // ===== v1.4 任务 #statusbar-persist:仓库选择持久化 =====

  /**
   * 持久化当前选择的仓库
   *
   * - 同步写 localStorage（启动期 reconcile 用,**不**是持久化主路径）
   * - 异步 IPC user.prefs.set（不阻塞 UI;失败 console.warn 不弹 toast）
   * - 传 null 时清掉持久化（退出登录/手动清除时用）
   *
   * 调用方传 RepoDto + RepoProjectDto + giteaUrl;
   * 调用时机:useBoardActions.selectProject 完成后 / 退出登录
   *
   * 注意:RepoDto.id 是 gitea 后端的 number id,**不**是本机 project uuid;
   * RepoProjectDto.id 才是本机 uuid(主 IPC 用这个)
   */
  async function persistLastSelected(
    repoDto: RepoDto | null,
    project: RepoProjectDto | null,
    giteaUrl: string,
  ): Promise<void> {
    // 计算 value —— 没传完整三件套就清掉
    let value: RepoLastPrefValue | null = null;
    if (repoDto && project && giteaUrl) {
      value = {
        giteaUrl,
        owner: repoDto.owner,
        name: repoDto.name,
        projectId: project.id,
      };
    }

    // 同步写 localStorage（启动期 restore 用）
    try {
      if (value) {
        localStorage.setItem(REPO_LAST_STORAGE_KEY, JSON.stringify(value));
      } else {
        localStorage.removeItem(REPO_LAST_STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用（隐私模式 / quota）—— 静默
    }

    // 异步 IPC 持久化
    try {
      const entries: Record<string, unknown> = value
        ? { [REPO_LAST_PREF_KEY]: value }
        : { [REPO_LAST_PREF_KEY]: null };
      await getIpcClient().invokeNested('user', 'prefs', 'set', { entries });
    } catch (err) {
      // 静默失败 —— localStorage 已写/已删,下次启动仍能恢复/失效
      // console.warn 留痕（dev 调试用）
      // eslint-disable-next-line no-console
      console.warn('[repo] repo.last.selected persistence failed:', err);
    }
  }

  /**
   * 启动期 reconcile（App.vue mount 后调一次）
   *
   * 1. 同步:localStorage 读 → 校验 → 标记 "有持久化候选"
   * 2. 异步:IPC user.prefs.get 拉权威值 → 不一致则用 prefs 覆盖 localStorage
   *
   * 不在此函数内 selectProject —— 仓库列表(RepoDto[])此时可能还没加载,
   * caller(App.vue)拿 reconcile 结果 + loadRepos 后再决定是否能 selectProject。
   *
   * 返:
   *   - null:没有持久化 / 持久化已失效(giteaUrl 不匹配) / 校验失败
   *   - RepoLastPrefValue:有持久化,值得后续尝试 selectProject
   */
  async function restoreLastSelected(currentGiteaUrl: string): Promise<RepoLastPrefValue | null> {
    // 1. 同步:localStorage 兜底
    let cached: RepoLastPrefValue | null = null;
    try {
      const raw = localStorage.getItem(REPO_LAST_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (isRepoLastPrefValue(parsed) && parsed.giteaUrl === currentGiteaUrl) {
          cached = parsed;
        }
      }
    } catch {
      // localStorage 不可用 / JSON.parse 失败 → 保持 null
    }

    // 2. 异步:IPC 拉权威值
    let fromPrefs: RepoLastPrefValue | null = null;
    try {
      const result = (await getIpcClient().invokeNested('user', 'prefs', 'get', {
        keys: [REPO_LAST_PREF_KEY],
      })) as Record<string, unknown> | null;
      const v = result?.[REPO_LAST_PREF_KEY];
      if (isRepoLastPrefValue(v) && v.giteaUrl === currentGiteaUrl) {
        fromPrefs = v;
      }
    } catch {
      // 静默
    }

    // 3. 取权威值(prefs > localStorage);都不行 → 返 null
    const final = fromPrefs ?? cached;
    if (!final) return null;

    // 4. 同步两边:prefs 拿到值则写 localStorage(单源策略,以 prefs 为准)
    if (fromPrefs && !cached) {
      try {
        localStorage.setItem(REPO_LAST_STORAGE_KEY, JSON.stringify(fromPrefs));
      } catch {
        /* ignore */
      }
    }
    // prefs 没值但 localStorage 有 → 用 localStorage 写回 prefs(双端对齐)
    if (!fromPrefs && cached) {
      try {
        await getIpcClient().invokeNested('user', 'prefs', 'set', {
          entries: { [REPO_LAST_PREF_KEY]: cached },
        });
      } catch {
        /* ignore */
      }
    }
    return final;
  }

  // ===== v2.3 StatusBar 仓库管理面板：clone 状态缓存 =====
  /**
   * 已 clone 状态缓存：key = `${owner}/${repo}` → boolean
   *
   * 设计：
   *   - 状态来自后端 IsRepoCloned 检查（查 .git 目录是否存在）
   *   - 每次 loadRepos 后批量更新一次（按当前 repos[] 列表）
   *   - 单独 owner/repo 也支持 query 临时检查
   *   - clone / pull 成功后本地更新（不重新调 IsRepoCloned）
   */
  const clonedMap = ref<Record<string, boolean>>({});

  /** key = owner/repo */
  function cloneKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  // ===== v2.6 同步进度（StatusBar 行末按钮下方的进度条数据源）=====
  /**
   * 同步进度缓存：key = `${owner}/${repo}` → SyncProgress
   *
   * 数据来源：后端 wails runtime.EventsEmit("git:sync:progress", payload)
   * 订阅在 setup 里挂一次（onMounted → store.initProgressEvents()），写入 progressByRepo
   *
   * UI 消费：StatusBar.vue:onSyncClick / onUpdateClick 时把 busyRepoKey + progressByRepo[key] 渲染
   * 完成后（success 或 error）后端最后会发 StageDone / StageError 事件，
   * 前端在 doneProgressWithDelay 里延迟清掉（让用户能看到 100% / 错误态一帧）
   */
  const progressByRepo = ref<Record<string, SyncProgress>>({});

  /**
   * v2.6 初始化进度事件订阅
   *
   * 调用时机：App.vue mount 时（store 是单例，必须确保只挂一次）
   * 实际上 Pinia store setup 只跑一次，所以 onMounted 在 App.vue 里挂一次也够。
   * 这里暴露成函数方便 useRepoStore() 直接调
   */
  function initProgressEvents(): () => void {
    // 前端 ipc-client 已有 on(event, cb) 通用监听；用 getIpcClient() 拿单例
    // 通过 window.go.events.on(...) 也行，但 ipc-client 是抽象层，更稳
    const client = getIpcClient();
    const off = client.on(GitSyncProgressEvent, (payload: unknown) => {
      // Wails JSON 解码：Go 的 `RepoKey` / `Stage` 自动转成 camelCase `repoKey` / `stage`
      const p = payload as GitSyncProgressPayload;
      if (!p || !p.repoKey) return;
      // StageDone / StageError：100ms 后清掉（让 UI 渲染一帧最终态）
      if (p.stage === 'done' || p.stage === 'error') {
        progressByRepo.value = { ...progressByRepo.value, [p.repoKey]: p };
        // 用 setTimeout 避免 setTimeout 嵌套在 Vue 渲染路径里
        const key = p.repoKey;
        setTimeout(() => {
          // 防御：期间又被新进度覆盖 → 不删
          const cur = progressByRepo.value[key];
          if (cur && cur.stage === p.stage) {
            const next = { ...progressByRepo.value };
            delete next[key];
            progressByRepo.value = next;
          }
        }, 1200);
        return;
      }
      progressByRepo.value = { ...progressByRepo.value, [p.repoKey]: p };
    });
    return off;
  }

  /**
   * 批量刷新已 clone 状态（loadRepos 完成后调一次）
   *
   * 注：现在 repos store 还依赖 gitea repos list 的 stub 路径，没真后端。
   *     真实场景下 repos[] 来自 gitea API，每个 owner/repo 都过 IsRepoCloned。
   *     为避免 N+1 同步阻塞 UI，clone check 用 Promise.all 并发；
   *     失败 → 当成 false（按钮显示"同步"，符合"我还没下"的预期）。
   */
  async function refreshClonedStatus(): Promise<void> {
    const auth = useAuthStore();
    if (!auth.isConnected) {
      clonedMap.value = {};
      return;
    }
    const acc = auth.accounts[0]; // v2.5：clone status 按当前账号 username 查
    const username = acc?.username;
    const next: Record<string, boolean> = {};
    await Promise.all(
      repos.value.map(async (r) => {
        const key = cloneKey(r.owner, r.name);
        try {
          next[key] = await commitsGitgraphIsRepoCloned({
            username,
            owner: r.owner,
            repo: r.name,
          });
        } catch {
          next[key] = false;
        }
      }),
    );
    clonedMap.value = next;
  }

  /**
   * clone 仓库到本地 workspace（v2.3：不传 token，Go 端从 keychain 拿）
   *
   * v2.x：优先按 projectId 协议走，让 Go 端按 project→account 反查 platform/hostUrl/username。
   *   - 原因：用户可能连了多个账号（一个 Gitea、一个 GitHub），同 owner/repo 可能在不同账号下。
   *     旧实现 `accounts[0]` 在多账号场景下永远把 GitHub 仓库当 Gitea 走（错的 adapter）。
   *   - GitHub 仓库必须走 `gh repo clone` + blobless partial fetch（见 App.PullRepoByProjectId）
   *     而 Gitea 仓库走 go-git PlainClone；分错平台会导致 clone 失败或拉不到 commit。
   *   - 走 projectId 协议后，Go 端按 RepoProject.Platform 选 adapter（giteaAdapter vs githubAdapter），
   *     二者的服务实现天然区分（go-git vs gh）。
   *
   * Fallback：列表里还没 project 记录（旧版 ListRepos 之前被选过的 repo）→ 走旧协议按当前已连账号。
   * 这种情况只在极少数迁移场景发生，绝大多数调用都走 projectId 分支。
   *
   * @returns localPath（成功）/ 抛 UserFacingError（失败）
   */
  async function cloneRepo(owner: string, repo: string): Promise<string> {
    const auth = useAuthStore();
    if (!auth.accounts.length) {
      throw {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何账号',
        hint: '请先连接 gitea 或 GitHub',
        recoverable: true,
      } satisfies UserFacingError;
    }
    loading.value = true;
    useGlobalLoadingStore().show('repo'); // v2.3：复用 'repo' namespace
    error.value = null;
    try {
      // 先在当前仓库列表里找匹配项，取它的 projectId（v2.x 反查 account 的钥匙）。
      // 注意：loadRepos() 当前按 `accounts[0]` 列出的，所以同一时刻列表里只会有"第一个账号"
      //       的仓库 + 该账号已存在的 project；要拿到其它账号的仓库需要先切账号或合并列表。
      //       多账号完整支持属于另一张卡，本次先把"已 clone 同步走对平台"修对。
      const matched = repos.value.find(
        (it) => it.owner === owner && it.name === repo,
      );
      const projectId = matched?.projectId;
      if (projectId) {
        // 走新协议：Go 端 App.CloneRepo 按 projectId 反查 account → 正确 adapter
        const r = await commitsGitgraphCloneRepo({ projectId });
        clonedMap.value[cloneKey(owner, repo)] = true;
        return r.localPath;
      }
      // Fallback：旧协议，按当前已连账号传 platform/hostUrl/username
      //   （仅用于本地 store 里没 project 记录的迁移场景）
      const acc = auth.accounts[0];
      const r = await commitsGitgraphCloneRepo({
        platform: acc.platform as 'gitea' | 'github',
        hostUrl: acc.giteaUrl,
        username: acc.username,
        owner,
        repo,
      });
      clonedMap.value[cloneKey(owner, repo)] = true;
      return r.localPath;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  /**
   * pull 仓库最新改动（git fetch + pull --rebase）
   *
   * v2.3：不再传 token，Go 端从 localPath 反查（AGENTS §8.2 鉴权铁律）
   * v2.4：仍保留，旧版 localPath 方式（cloneRepo 同步在 localStore.Projects 加记录后可用）
   *
   * @returns PullRepoResult（成功）/ 抛 UserFacingError（失败）
   */
  async function pullRepo(args: { localPath: string }): Promise<{
    beforeCount: number;
    afterCount: number;
    addedCommits: number;
    headChanged: boolean;
  }> {
    const auth = useAuthStore();
    if (!auth.isConnected) {
      throw {
        code: 'unauthenticated',
        messageText: '需要登录：尚未连接任何 gitea 实例',
        hint: '请先连接 gitea',
        recoverable: true,
      } satisfies UserFacingError;
    }
    loading.value = true;
    useGlobalLoadingStore().show('repo');
    error.value = null;
    try {
      const r = await commitsGitgraphPull({
        localPath: args.localPath,
      });
      return r;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  /**
   * pull 仓库（v2.4 · 按 projectId 走，Go 端反查 localPath + token）
   *
   * 修复 StatusBar 更新按钮 localPath 拼接 bug：
   *   - 旧版前端拼 `~/.gitea-kanban/workspace/repos/...` → Go 端拒绝
   *   - 新版只传 projectId，Go 端按 owner+repo + workspacePath 反算
   */
  async function pullRepoByProjectId(args: { projectId: string }): Promise<{
    beforeCount: number;
    afterCount: number;
    addedCommits: number;
    headChanged: boolean;
    headBefore: string;
    headAfter: string;
  }> {
    loading.value = true;
    useGlobalLoadingStore().show('repo');
    error.value = null;
    try {
      const r = await commitsGitgraphPull({
        projectId: args.projectId,
      });
      return r;
    } catch (e) {
      error.value = normalizeError(e);
      throw e;
    } finally {
      loading.value = false;
      useGlobalLoadingStore().hide('repo');
    }
  }

  return {
    // state
    repos,
    total,
    hasMore,
    currentProject,
    currentProjectId,
    loading,
    error,
    guideOnConnect,
    clonedMap,
    // getters
    currentRepo,
    projects,
    // actions
    loadRepos,
    selectProject,
    addProject,
    removeProject,
    clearError,
    consumeGuideOnConnect,
    persistLastSelected,
    restoreLastSelected,
    // v2.3
    refreshClonedStatus,
    cloneRepo,
    pullRepo,
    // v2.4
    pullRepoByProjectId,
    // v2.6 同步进度（StatusBar 行末进度条）
    progressByRepo,
    initProgressEvents,
  };
});
