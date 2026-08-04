# IntelliJ Platform Smart Update 机制分析

> 整理自仓库 `d:\2026\github\rebased`（IntelliJ IDEA Platform 社区版 monorepo，Kotlin/Java + Bazel + IntelliJ Platform SDK）。
>
> 仓库内对应模块：`platform/smart-update`（`intellij.smart.update`）。
>
> 该功能在中文社区语境下常被称作 “智能拉取 / 智能更新”，源码内正式名称为 **Smart Update**，对外 Action 文案为 `Auto Update…`。

---

## 1. 模块概览

### 1.1 目录结构

```
platform/smart-update/
├── BUILD.bazel
├── intellij.smart.update.iml
├── plugin-content.yaml
├── resources/
│   ├── META-INF/
│   │   ├── plugin.xml
│   │   ├── pluginIcon.svg
│   │   └── pluginIcon_dark.svg
│   └── messages/
│       └── SmartUpdateBundle.properties
└── src/com/intellij/smartUpdate/
    ├── SmartUpdate.kt              // 项目级 Service + Action + 调度
    ├── SmartUpdateStep.kt          // 扩展点契约
    ├── SmartUpdateDialog.kt        // 配置对话框
    ├── IdeUpdateStep.kt            // 升级 IDE（Toolbox）+ IdeRestartedActivity
    ├── PluginsUpdateStep.kt        // 升级插件
    ├── VcsUpdateStep.kt            // VCS Update 流程
    ├── BuildProjectStep.kt         // 构建项目
    ├── SmartUpdateBundle.kt        // 资源 bundle 包装
    └── SmartUpdateUsagesCollector.kt // 统计事件
```

> 备注：本模块在源码树中未见 `testSrc/`，目前没有随模块发布的单元测试。

### 1.2 模块依赖（来自 `intellij.smart.update.iml` 与 `BUILD.bazel`）

| 类型 | 模块 / 库 |
| --- | --- |
| Kotlin 运行时 | `kotlin-stdlib` |
| 平台核心 | `intellij.platform.core` / `core-impl` / `core-ui` |
| IDE 基础 | `intellij.platform.ide.core` / `ide.core.impl` / `ide.impl` / `ide.ui` |
| 项目模型 | `intellij.platform.projectModel` |
| 编辑器 | `intellij.platform.editor.ui` |
| 语言 | `intellij.platform.lang` / `lang.impl` |
| VCS | `intellij.platform.vcs` / `vcs.impl`（**plugin.xml 唯一硬依赖**） |
| 内置服务 | `intellij.platform.builtInServer.impl` |
| 统计 | `intellij.platform.statistics` |
| 升级检查 | `intellij.platform.ide.updateChecker` |
| UI 工具 | `intellij.platform.util.ui` |

插件只显式声明 `<module name="intellij.platform.vcs.impl"/>`，其它依赖通过 `.iml` 进入 `runtime classpath`。

### 1.3 插件自描述（`resources/META-INF/plugin.xml` 节选）

```xml
<idea-plugin package="com.intellij.smartUpdate">
  <id>com.intellij.smartUpdate</id>
  <name>Smart Update</name>
  <vendor>JetBrains</vendor>
  <description>Enables Auto Update action that schedules automatic IDE and plugin updates.</description>

  <dependencies>
    <module name="intellij.platform.vcs.impl"/>
  </dependencies>

  <extensionPoints>
    <extensionPoint qualifiedName="com.intellij.smartUpdateStep"
                    interface="com.intellij.smartUpdate.SmartUpdateStep" dynamic="true"/>
  </extensionPoints>

  <extensions defaultExtensionNs="com.intellij">
    <smartUpdateStep id="ide.update"      implementation="com.intellij.smartUpdate.IdeUpdateStep"/>
    <smartUpdateStep id="plugins.update"  implementation="com.intellij.smartUpdate.PluginsUpdateStep"/>
    <smartUpdateStep id="vcs.update"      implementation="com.intellij.smartUpdate.VcsUpdateStep"/>
    <smartUpdateStep id="build.project"   implementation="com.intellij.smartUpdate.BuildProjectStep"/>

    <backgroundPostStartupActivity implementation="com.intellij.smartUpdate.IdeRestartedActivity"/>
    <statistics.counterUsagesCollector implementationClass="com.intellij.smartUpdate.SmartUpdateUsagesCollector"/>

    <registryKey key="ide.smart.update" defaultValue="true"
                 description="Enables the 'Update and Build' action ..."/>
    <projectSettings service="com.intellij.smartUpdate.SmartUpdate"/>
  </extensions>

  <actions resource-bundle="messages.SmartUpdateBundle">
    <action id="smart.update" class="com.intellij.smartUpdate.SmartUpdateAction">
      <add-to-group group-id="UpdateEntryPointGroup"/>
    </action>
  </actions>
</idea-plugin>
```

关键点：

- 暴露 **一个** Action：`smart.update`，加入 `UpdateEntryPointGroup`（平台通用更新入口组）。
- 提供 **一个** 扩展点 `com.intellij.smartUpdateStep`，用于接入新的更新子步骤。
- 自身注册 4 个内置 step、`backgroundPostStartupActivity`、统计收集器、注册项 `ide.smart.update`、项目级 Service `SmartUpdate`。

---

## 2. 核心抽象：扩展点契约

`SmartUpdateStep.kt` 定义了整个机制的接口。

```kotlin
internal val EP_NAME =
  ExtensionPointName.create<SmartUpdateStep>("com.intellij.smartUpdateStep")

interface SmartUpdateStep {
  val id: @NonNls String
  val stepName: @Nls String

  /**
   * Perform an update step and proceed by invoking onSuccess()
   * @param e null if a task is invoked after restart or by scheduler, otherwise user-initiated
   * @param onSuccess must be called to proceed to the next step
   */
  fun performUpdateStep(project: Project, e: AnActionEvent? = null, onSuccess: () -> Unit)
  fun isAvailable(project: Project): Boolean = true
  fun getDetailsComponent(project: Project): JComponent? = null
  fun detailsVisible(project: Project): ComponentPredicate = ComponentPredicate.TRUE
}

interface StepOption : SmartUpdateStep {
  val optionName: @Nls String
  val groupName: @Nls String
}
```

设计要点：

1. **回调推进**：每个 step 必须调用 `onSuccess()` 才能进入下一步，避免一次性串行阻塞主流程；适合 IDE/插件/VCS/构建这种长耗时、可能涉及重启的操作。
2. **入口场景区分**：`AnActionEvent` 不为 null 表示 “用户从菜单触发”，为 null 表示 “IDE 重启回来续跑” 或 “调度器触发”，后两者需要先重新拉取最新状态（`UpdateChecker.getUpdates().doWhenProcessed`）。
3. **可选 UI 钩子**：`getDetailsComponent` + `detailsVisible` 让 step 能在对话框中提供额外说明（例如 `VcsUpdateStep` 暴露 “Change options…” 链接）。
4. **`StepOption` 子类型**：用于把多个互斥的更新方式合并到同一组下拉框（典型例子就是 `IdeUpdateStep` 唯一一组 `Update IDE from Toolbox`，未来若加入 “Update from zip” 之类即可并列）。

---

## 3. 执行管线：Service 与 Action

`SmartUpdate.kt` 既是项目级 Service，也是 Action 实现。核心代码（已加注释）：

```kotlin
@State(name = "SmartUpdateOptions",
       storages = [Storage(value = StoragePathMacros.WORKSPACE_FILE,
                           roamingType = RoamingType.DISABLED)])
@Service(Service.Level.PROJECT)
internal class SmartUpdate(
  val project: Project,
  private val coroutineScope: CoroutineScope,
) : PersistentStateComponent<SmartUpdate.Options>, Disposable {

  class Options : BaseState() {
    var scheduled by property(false)
    var scheduledTime by property(LocalTime.of(8, 0).toSecondOfDay())   // 默认 8:00

    @get:MapAnnotation(surroundWithTag = false)
    var map: MutableMap<String, Boolean> by linkedMap()
    fun value(id: String) = map[id] ?: true
    fun property(id: String) = MutableProperty({ value(id) }, { map[id] = it })
  }

  var restartRequested = false
  private var updateScheduled: Deferred<*>? = null
  private val options = Options()

  init {
    // 监听全局升级动作；IDE 重启回到这一步时由 ToolboxUpdateAction 触发
    ApplicationManager.getApplication().messageBus.connect(this)
      .subscribe(UpdateActionsListener.TOPIC, object : UpdateActionsListener {
        override fun actionReceived(action: UpdateAction) {
          if (restartRequested && action.isRestartRequired && action is ToolboxUpdateAction) {
            restartRequested = false
            restartIde(project) { action.perform() }
          }
        }
      })
  }

  override fun getState() = options
  override fun loadState(state: Options) = XmlSerializerUtil.copyBean(state, options)

  fun availableSteps(): List<SmartUpdateStep> =
    EP_NAME.extensionList.filter { it.isAvailable(project) }

  fun execute(project: Project, e: AnActionEvent? = null) {
    val steps = LinkedList(availableSteps().filter { options.value(it.id) })
    LOG.info("Executing ${steps.joinToString(" ")}")
    executeNext(steps, project, e)
    scheduleUpdate()
  }

  private fun executeNext(steps: Queue<SmartUpdateStep>, project: Project, e: AnActionEvent?) {
    val step = steps.poll()
    LOG.info("Next step: ${step}")
    step?.performUpdateStep(project, e) { executeNext(steps, project, e) }
  }

  internal fun scheduleUpdate() {
    if (!options.scheduled) return
    updateScheduled?.cancel()
    updateScheduled = coroutineScope.async {
      var duration = Duration.between(LocalTime.now(), LocalTime.ofSecondOfDay(options.scheduledTime.toLong()))
      if (duration.isNegative) duration = duration.plusDays(1)
      SmartUpdateUsagesCollector.logScheduled()
      delay(duration.toMillis())
      LOG.info("Scheduled update started")
      execute(project)
    }
  }
}

internal class SmartUpdateAction : DumbAwareAction() {
  override fun actionPerformed(e: AnActionEvent) {
    val project = getEventProject(e)!!
    if (SmartUpdateDialog(project).showAndGet()) {
      project.service<SmartUpdate>().execute(project, e)
    }
    project.service<SmartUpdate>().scheduleUpdate()
  }

  override fun update(e: AnActionEvent) {
    val project = e.project
    if (!Registry.`is`("ide.smart.update", false) || project == null) {
      e.presentation.isEnabledAndVisible = false; return
    }
    if (!ProjectLevelVcsManager.getInstance(project).hasActiveVcss()) {
      e.presentation.setEnabledAndVisible(false); return
    }
    e.presentation.text = templateText
  }

  override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}
```

### 3.1 状态机

```
┌────────────────┐ showAndGet() ┌──────────────┐
│  用户触发 Action ├──────────────▶  SmartUpdateDialog │ OK
└────────────────┘              └──────┬───────┘
                                      │
                                      ▼
                          SmartUpdate.execute(project, e)
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        step1.performUpdateStep → onSuccess → step2... → stepN
              │
              └─ onError/异常 ──▶ 链路中断（不进入下一步）
                                      │
                                      ▼
                          SmartUpdate.scheduleUpdate()
                          （按 options.scheduled 决定是否启协程定时）
```

### 3.2 关键设计取舍

- **回调链 vs 协程链**：用 `Queue + onSuccess` 显式推进，保留 “可中断” 与 “可重启” 语义，代价是每步必须正确调用 `onSuccess`（实际 `BuildProjectStep` 在 `onError` 时不会调用，会把后续步骤全部短路，是已知行为）。
- **持久化范围**：仅写入 `workspace.xml`、关闭 Roaming；调度时间等不该跨机器漫游。
- **协程调度**：`updateScheduled` 用 `async` 持有任务引用，便于在 `scheduleUpdate()` 被多次触发时取消上一个等待；调度目标时间若已过则推到次日。
- **重启续跑**：`restartRequested` 与全局 `UpdateActionsListener` 配合，让 IDE 升级这种 “必须重启 IDE 才能生效” 的步骤，在新进程内继续后续 step。

---

## 4. 各步骤实现

### 4.1 `IdeUpdateStep` + `IdeRestartedActivity`（同文件）

```kotlin
internal class IdeUpdateStep : StepOption {
  override val id = "ide.update"
  override val stepName = SmartUpdateBundle.message("checkbox.update.ide")
  override val optionName = SmartUpdateBundle.message("update.ide.option.toolbox")
  override val groupName = SmartUpdateBundle.message("update.ide.group")

  override fun performUpdateStep(project: Project, e: AnActionEvent?, onSuccess: () -> Unit) {
    val updateAction = getUpdateAction()
    if (updateAction != null) {
      updateAction.perform()
      project.service<SmartUpdate>().restartRequested = true
    } else onSuccess()
  }
  // ...
}

private fun getUpdateAction() =
  service<ToolboxSettingsActionRegistry>().getActions()
    .find { it is ToolboxUpdateAction } as? ToolboxUpdateAction

fun restartIde(project: Project, title: String, restart: () -> Unit) {
  restartOrNotify(project, true, title) {
    beforeRestart()
    restart()
  }
}

fun beforeRestart() {
  RecentProjectsManagerBase.getInstanceEx().forceReopenProjects()
  PropertiesComponent.getInstance().setValue(IDE_RESTARTED_KEY, true)
}

internal class IdeRestartedActivity : ProjectActivity {
  override suspend fun execute(project: Project) {
    val service = project.service<SmartUpdate>()
    if (PropertiesComponent.getInstance().isTrueValue(IDE_RESTARTED_KEY)) {
      PropertiesComponent.getInstance().setValue(IDE_RESTARTED_KEY, false)
      notifyIdeUpdate(project)
      service.execute(project)   // 续跑剩余 step
    } else {
      service.scheduleUpdate()    // 首次启动按需挂调度
    }
  }
}
```

要点：

- 通过 `ToolboxSettingsActionRegistry` 间接拿到 `ToolboxUpdateAction`，依赖 `org.jetbrains.ide` 的升级桥。
- 重启前写 `smart.update.ide.restarted=true` 到 `PropertiesComponent`；`IdeRestartedActivity` 启动时读取，命中即视为 “升级回来了”，清理标志位、通知用户、继续跑后续 step；未命中则直接挂调度器。
- `getDetailsComponent` 返回当前 `ToolboxUpdateAction` 的展示文本（无更新时显示 `No updates available`）。

### 4.2 `PluginsUpdateStep`

```kotlin
internal class PluginsUpdateStep : SmartUpdateStep {
  override val id = "plugins.update"
  override val stepName = SmartUpdateBundle.message("update.plugins")

  override fun performUpdateStep(project: Project, e: AnActionEvent?, onSuccess: () -> Unit) {
    val doUpdate = {
      val updates = getPendingUpdates()
      if (updates.isNullOrEmpty()) onSuccess()
      else {
        val component = e?.dataContext?.getData(PlatformDataKeys.CONTEXT_COMPONENT) as? JComponent
        installUpdates(updates, component, Consumer { restartRequired ->
          if (restartRequired) restartIde(project, ..., { getApplicationEx().restart(true) })
          else onSuccess()
        })
      }
    }
    if (e == null) UpdateChecker.getUpdates().doWhenProcessed(Runnable(doUpdate))
    else doUpdate()
  }
}
```

要点：

- 用户触发时直接拿 `getPendingUpdates()`，避免阻塞 UI 线程。
- 调度器/重启续跑场景下必须先 `UpdateChecker.getUpdates()` 拉一次再判断，否则 `pendingUpdates` 可能为空被错误地 “no updates” 跳过。
- 安装完成后若需重启，则 `getApplicationEx().restart(true)`，并复用 `SmartUpdate.restartRequested` 让 `IdeRestartedActivity` 在重启后接上。

### 4.3 `VcsUpdateStep`

```kotlin
internal class VcsUpdateStep : SmartUpdateStep {
  private val actionInfo = ActionInfo.UPDATE
  private val scopeInfo  = ScopeInfo.PROJECT
  override val id = "vcs.update"
  override val stepName = SmartUpdateBundle.message("checkbox.update.project")

  override fun performUpdateStep(project: Project, e: AnActionEvent?, onSuccess: () -> Unit) {
    val start = System.currentTimeMillis()
    val dataContext = SimpleDataContext.getProjectContext(project)
    VcsUpdateProcess.launchUpdate(
      project, actionInfo, scopeInfo, dataContext, false,
      SmartUpdateBundle.message("action.update.project.text"),
    ) {
      SmartUpdateUsagesCollector.logUpdate(System.currentTimeMillis() - start)
      onSuccess.invoke()
    }
  }
  // ...
}
```

要点：

- 直接复用 `VcsUpdateProcess`（位于 `intellij.platform.vcs.impl`），`ActionInfo.UPDATE` + `ScopeInfo.PROJECT` 表示 “全项目更新”。
- 传入 `SimpleDataContext.getProjectContext(project)` 作为数据上下文，避免依赖调用方 `e`。
- `getDetailsComponent` 在 `ActionInfo.showOptions(project)` 返回 true 时显示 “Change options…” 链接，调用 `VcsUpdateProcess.showOptionsDialog` 弹出 VCS 自带的选项对话框；`detailsVisible` 监听该判断的变化。
- 每次更新都向 `SmartUpdateUsagesCollector` 上报耗时（事件 `vcs.update`）。

### 4.4 `BuildProjectStep`

```kotlin
internal class BuildProjectStep : SmartUpdateStep {
  override val id = "build.project"
  override val stepName = SmartUpdateBundle.message("checkbox.build.project")

  override fun performUpdateStep(project: Project, e: AnActionEvent?, onSuccess: () -> Unit) {
    val start = System.currentTimeMillis()
    ProjectTaskManagerImpl.putBuildOriginator(project, this.javaClass)
    ProjectTaskManager.getInstance(project).buildAllModules()
      .onSuccess {
        SmartUpdateUsagesCollector.logBuild(System.currentTimeMillis() - start, true)
        onSuccess.invoke()
      }
      .onError {
        SmartUpdateUsagesCollector.logBuild(System.currentTimeMillis() - start, false)
        // 注意：onError 没有调用 onSuccess，后续 step 不会执行
      }
  }
}
```

要点：

- 用 `ProjectTaskManagerImpl.putBuildOriginator` 标记构建来源，IDE 内其它模块可根据此标记调整 UI/通知。
- 构建失败时 `onError` 仅记录统计，但 **不会调用 `onSuccess`**，因此后续 step（如有）会被自动跳过。设计上是 “构建失败就停”。

---

## 5. 对话框与持久化

`SmartUpdateDialog.kt` 是 UI 配置面板，核心是 DSL（`com.intellij.ui.dsl.builder`）按 `StepOption.groupName` 分组渲染：

```kotlin
return panel {
  for (group in groups) {
    lateinit var checkbox: Cell<JBCheckBox>
    lateinit var combobox: Cell<ComboBox<SmartUpdateStep>>
    row {
      checkbox = checkBox(group.key)
      combobox = comboBox(group.value, textListCellRenderer("") {
        (it as? StepOption)?.optionName
      }).visible(group.value.size > 1)
    }
    for (step in group.value) {
      step.getDetailsComponent(project)?.let {
        indent { row { cell(it) } }.visibleIf(
          checkbox.selected.and(combobox.component.selectedValueIs(step))
            .and(step.detailsVisible(project))
        )
      }
    }
    combobox.component.selectedItem = group.value.find { options.value(it.id) } ?: group.value.first()
    checkbox.component.isSelected = options.value((combobox.component.selectedItem as SmartUpdateStep).id)
    combobox.onApply {
      group.value.forEach {
        options.property(it.id).set(checkbox.component.isSelected && it == combobox.component.item)
      }
    }
  }
  separator()
  lateinit var scheduled: Cell<JBCheckBox>
  row { scheduled = checkBox(SmartUpdateBundle.message("checkbox.schedule.update"))
      .bindSelected({ options.scheduled }, { options.scheduled = it }) }
  indent {
    val time = LocalTime.ofSecondOfDay(options.scheduledTime.toLong())
    val formatter = DateTimeFormatter.ofPattern("HH:mm")
    row {
      label(SmartUpdateBundle.message("label.every.day.at"))
      val field = JFormattedTextField(MaskFormatter("##:##").apply { placeholderCharacter = '0' })
        .apply { text = time.format(formatter) }
      cell(field).onApply {
        try { options.scheduledTime = LocalTime.parse(field.text, formatter).toSecondOfDay() }
        catch (e: Exception) { Logger.getInstance(SmartUpdateDialog::class.java).error(e) }
      }
    }.enabledIf(scheduled.selected)
  }
}.apply { minimumWidth = JBUIScale.scale(300) }
```

特点：

- 同一 group 下有多个 step 时，下拉框选择具体那一个；勾选框统一控制整组开关。
- 详情组件跟随 `checkbox.selected ∧ combobox.selectedValueIs(step) ∧ step.detailsVisible(project)` 的复合谓词显示/隐藏。
- 调度时间用 `MaskFormatter("##:##")` 限定输入格式；解析失败仅日志，不回弹错误（轻量处理）。
- `doCancelAction` 也会 `applyFields()`，确保关闭按钮也能保存选项。

---

## 6. 统计与可观测性

`SmartUpdateUsagesCollector.kt` 注册 `EventLogGroup("smart.update", 3)`：

| 事件 | 字段 | 触发位置 |
| --- | --- | --- |
| `vcs.update` | `DurationMs` | `VcsUpdateStep.performUpdateStep` 完成回调 |
| `build.project` | `DurationMs`, `Boolean("success")` | `BuildProjectStep` 的 `onSuccess`/`onError` |
| `scheduled` | — | 调度器在 `delay` 前先打点 |

这为 “智能拉取” 行为提供了使用率与执行耗时的遥测数据，方便后续做产品决策。

---

## 7. 资源文案

`resources/messages/SmartUpdateBundle.properties` 节选（i18n key 与 `SmartUpdateBundle.kt` 配合使用）：

```properties
action.smart.update.text=Auto Update…
action.update.project.text=Update Project
checkbox.build.project=&Build project
checkbox.update.project=&Update project
checkbox.update.ide=Update &IDE from Toolbox
update.ide.group=Update &IDE
update.ide.option.toolbox=from Toolbox
dialog.title.smart.update=Auto Update
no.updates.available=No updates available
checkbox.schedule.update=Schedule update
label.every.day.at=Every day at
button.update.now=Update Now
warning.default.update.options.will.be.applied=WARNING: Default update options will be applied
label.change.options=Change options…
update.plugins=Update plugins
update.plugin=Update {0}
update.several.plugins=Update {0} plugins
checking.for.updates=Checking for updates…
dialog.title.plugin.updates.ready.to.install=Plugin Updates Ready to Install
```

外发到用户面前的所有可见文本都在该文件中，符合仓库 “用户可见字符串必须放 `*.properties` 本地化” 的不变量。

---

## 8. 调度、持久化与重启续跑

| 维度 | 现状 | 备注 |
| --- | --- | --- |
| 调度时间 | 默认 `LocalTime.of(8, 0)`，存为 `toSecondOfDay()` 整数 | 跨天处理：若已过去则 `plusDays(1)` |
| 调度粒度 | 每天一次 | 没有 “工作日/周末” 之类概念 |
| 持久化位置 | `workspace.xml`（`SmartUpdateOptions` 状态对象） | 关闭 Roaming |
| 注册项 | `ide.smart.update`，默认 `true` | 控制 Action 是否显示 |
| 启动钩子 | `backgroundPostStartupActivity` = `IdeRestartedActivity` | 启动时识别 “IDE 刚被自己重启回来” 并续跑 |
| 重启标志 | `PropertiesComponent "smart.update.ide.restarted"` | 应用级（非项目级），重启后由 `IdeRestartedActivity` 清理 |
| 强制重启动作 | `getApplicationEx().restart(true)` | 走 `ApplicationEx.restart` 平台 API |

---

## 9. 风险与改进建议

> 以下均为基于源码静态阅读得到的判断，尚未运行测试。

1. **构建失败的处理语义不一致**：`BuildProjectStep` 在 `onError` 时不调用 `onSuccess`，链路立即中断；但 `VcsUpdateStep`/`PluginsUpdateStep` 的 `VcsUpdateProcess.launchUpdate`/`installUpdates` 在异常时如何回调需要进一步核验。设计文档层面建议统一 “失败 = 终止后续” 的契约。
2. **没有单元测试**：`platform/smart-update/` 无 `testSrc/`，建议至少覆盖：
   - `SmartUpdate.execute` 的步骤过滤与 `onSuccess` 链路。
   - `scheduleUpdate` 的 “跨天” 计算。
   - `IdeUpdateStep` 在 `restartRequested` 下的状态机。
   - `SmartUpdateDialog` 的勾选/下拉交互（`comboBox` + `bindSelected`）。
3. **错误信息偏静默**：调度时间解析失败只打日志；建议在对话框里加可见错误。
4. **`UpdateEntryPointGroup` 的位置未在源码内交叉确认**：`plugin.xml` 引用该 Action Group，但仓库范围搜索因 ripgrep 在 monorepo 全量扫描下不可靠，未能在本轮落实其定义来源（推测在 `platform/platform-impl` 或 IDE 产品模块）。后续可用 `codegraph_symbol_search` 精确定位。
5. **Plugin id 与未来拆分**：当前 `com.intellij.smartUpdate` 整体位于 `platform/smart-update`，仍属于 “platform 插件”；如果未来要把 “智能拉取” 拆出独立 plugin，需要重写 `Storage` / `restartOrNotify` 等依赖 `intellij.platform.vcs.impl` 的调用点。
6. **统计事件版本**：`EventLogGroup("smart.update", 3)` 版本号 v3，若新增字段需走 `EventLogGroup` 版本升级流程。

---

## 10. 速查：扩展接入新 step

如需新增一个更新子步骤（如 “Update Docker Compose 服务”）：

1. 实现 `SmartUpdateStep`（或 `StepOption` 若需要并入 `group`）。
2. 在 `plugin.xml` 加 `<smartUpdateStep id="..." implementation="..."/>`。
3. 若有可见文本，写到 `SmartUpdateBundle.properties`。
4. 确认 `performUpdateStep` 在异步完成后一定调用 `onSuccess()`。
5. 重启/调度场景下若需要重新拉数据，参考 `PluginsUpdateStep` 在 `e == null` 时先 `UpdateChecker.getUpdates()`。
6. 必要时用 `SmartUpdateUsagesCollector.GROUP` 增补统计事件。

---

## 附录 A：相关文件清单

| 文件 | 角色 |
| --- | --- |
| `platform/smart-update/resources/META-INF/plugin.xml` | 插件描述、扩展点、Action、注册项、Service |
| `platform/smart-update/resources/messages/SmartUpdateBundle.properties` | i18n 文案 |
| `platform/smart-update/src/com/intellij/smartUpdate/SmartUpdate.kt` | Service + Action + 调度协程 |
| `platform/smart-update/src/com/intellij/smartUpdate/SmartUpdateStep.kt` | 扩展点接口 + `StepOption` |
| `platform/smart-update/src/com/intellij/smartUpdate/SmartUpdateDialog.kt` | 配置对话框（DSL） |
| `platform/smart-update/src/com/intellij/smartUpdate/IdeUpdateStep.kt` | IDE 升级 + `IdeRestartedActivity` |
| `platform/smart-update/src/com/intellij/smartUpdate/PluginsUpdateStep.kt` | 插件升级 |
| `platform/smart-update/src/com/intellij/smartUpdate/VcsUpdateStep.kt` | VCS 更新 |
| `platform/smart-update/src/com/intellij/smartUpdate/BuildProjectStep.kt` | 项目构建 |
| `platform/smart-update/src/com/intellij/smartUpdate/SmartUpdateBundle.kt` | bundle 包装 |
| `platform/smart-update/src/com/intellij/smartUpdate/SmartUpdateUsagesCollector.kt` | 统计事件 |
| `platform/smart-update/BUILD.bazel` | Bazel 构建 |
| `platform/smart-update/intellij.smart.update.iml` | IDE 模块描述 |
| `platform/smart-update/plugin-content.yaml` | 产物清单 |

## 附录 B：术语对照

| 仓库原文 | 中文常用译法 | 说明 |
| --- | --- | --- |
| Smart Update | 智能拉取 / 智能更新 | 本机制整体 |
| Auto Update | 自动更新 | Action 主按钮文案 |
| Smart Update Step | 更新子步骤 | 扩展点实现 |
| Schedule update | 定时更新 | 每日定时开关 |
| ToolboxUpdateAction | Toolbox 升级动作 | 由 IDE 主进程提供 |
| VcsUpdateProcess | VCS 更新流程 | `intellij.platform.vcs.impl` 提供 |
| Restarted Activity | 重启后启动活动 | `ProjectActivity` 钩子 |
