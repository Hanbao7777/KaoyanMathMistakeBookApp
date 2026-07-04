# TickTick 功能已知问题清单

整理时间：2026-05-26

用途：给 Claude Code 接手修复。请先通读 `TICKTICK_FEATURES.md`，再按下面的优先级逐项修。修完每项后至少跑：

```bash
npm.cmd run typecheck
npm.cmd run build
```

Electron 打包版也要实际打开验证，不要只看浏览器/Vite。

## P0：TickTick 主界面空白，主内容区宽度被挤成 12px

现象：
- 切到“任务/TickTick”后，左侧栏正常显示，但右侧大面积空白。
- 点击“今天 / 日历 / 收集箱”看起来没有内容。
- 运行时 DOM 验证结果：`.ticktick-app-shell` 被限制在旧 `.app-shell` 的第一列，宽度约 `252px`；`.ticktick-sidebar` 占 `240px`；`.ticktick-main` 只剩约 `12px`。

原因：
- `src/renderer/App.tsx` 的 TickTick 分支把新 TickTick shell 包在旧错题本布局 `.app-shell` 里面。
- `.app-shell` 在 `src/renderer/styles/global.css` 中是旧主界面的 grid：`252px minmax(0, 1fr)`，不适合 TickTick 的自有 flex shell。

涉及文件：
- `src/renderer/App.tsx`
- `src/renderer/styles/global.css`
- `src/renderer/styles/ticktick.css`

当前状态：
- 代码已修，待人工/打包版验收。TickTick 分支外层已从 `className="app-shell"` 改为 `className="ticktick-root"` 并渲染 `TickTickShell`，不再复用旧错题本布局。
- `.ticktick-root` / `.ticktick-app-shell` / `.ticktick-main` / `.ticktick-main-content` 的高度、`min-width:0` / `min-height:0` / overflow 规则已在 `ticktick.css` 补齐。
- 仍需在打包版逐页确认（见下方验收），确认前不标记为已完全闭环。

建议修法：
- TickTick 模式不要复用 `.app-shell`。
- 给 TickTick 独立根容器，例如：

```css
.ticktick-root {
  height: 100vh;
  min-height: 0;
  overflow: hidden;
}

.ticktick-app-shell {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.ticktick-main {
  min-width: 0;
  min-height: 0;
}

.ticktick-main-content {
  min-height: 0;
}
```

验收：
- 切到 TickTick 后，主内容区宽度应占满侧边栏右侧。
- 今天、日历、收集箱、清单详情、专注计时、设置都能显示真实内容。
- 页面不能出现整窗级横向滚动，侧边栏和主内容各自滚动正常。

## P0：专注计时和设置被挤到侧边栏很下面，且点击后看起来打不开

现象：
- “专注计时 / 设置”在侧边栏底部，但需要滚到很下面才能看到。
- 用户理解为这些功能跑进了日历页里面。
- 点击后因为主内容区被 P0 布局 bug 挤没了，看起来像打不开。

原因：
- `TickTickSidebar.tsx` 里工具区使用了 `style={{ marginTop: 'auto' }}`。
- 当父容器高度不是固定视口高度时，`marginTop: auto` 会把工具区推到整个文档底部。
- P0 使 `.ticktick-main` 只剩极窄宽度，进一步造成“点击无反应”的错觉。

涉及文件：
- `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- `src/renderer/styles/ticktick.css`

当前状态：
- 代码已修，待人工/打包版验收。侧边栏中间内容已包进 `.tt-sidebar-scroll`，工具区改为 `.tt-sidebar-tools`，已移除 inline `marginTop:'auto'`。
- 对应 CSS（`.ticktick-sidebar` / `.tt-sidebar-scroll` / `.tt-sidebar-tools`）已在 `ticktick.css` 补齐。
- 该项与主内容区宽度问题联动，仍需在打包版一并人工确认后才算闭环。

建议修法：
- 侧边栏本身固定窗口高度。
- 用户信息区和工具区固定，中间列表区单独滚动。

```css
.ticktick-sidebar {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.tt-sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.tt-sidebar-tools {
  flex-shrink: 0;
  border-top: 1px solid var(--tt-border-light);
  background: var(--tt-bg-sidebar);
}
```

验收：
- “专注计时 / 设置”不随日历或清单内容滚走。
- 不需要滚到底就能看到工具区。
- 点击专注计时和设置后，右侧主区能切换到对应页面。

## P0：exe 双击打不开，和 `ELECTRON_RUN_AS_NODE` 环境变量有关

现象：
- 双击 exe 后没有窗口，或进程一闪而过。
- 使用 `Start-Process` 启动打包版时，如果当前 shell 继承了 `ELECTRON_RUN_AS_NODE=0`，应用会直接退出；清掉当前进程变量后可以启动。

已确认：
- `cmd /c set ELECTRON` 输出过 `ELECTRON_RUN_AS_NODE=0`。
- PowerShell 的 `Env:` provider 曾报“已添加了具有相同键的项”，说明当前进程环境可能存在重复大小写键或残留键。
- 之前已经清过 User/Machine 级别变量，但当前 Codex/PowerShell 进程仍可能继承旧环境，需要重启 shell 或显式清理当前进程环境。

涉及点：
- 不是业务代码 bug，但会影响 Electron exe 启动。
- Electron 打包/测试脚本不要设置或继承 `ELECTRON_RUN_AS_NODE`。

建议处理：
- 修复说明文档里写清楚：如果 exe 打不开，先确认系统环境变量里没有 `ELECTRON_RUN_AS_NODE`。
- 本地调试命令启动 Electron 前显式清理：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
```

验收：
- 新开 PowerShell 后 `cmd /c set ELECTRON` 不应再看到 `ELECTRON_RUN_AS_NODE`。
- 双击 `release/win-unpacked/考研高数错题本.exe` 能打开窗口。
- 双击 portable 安装包/免安装 exe 也能打开窗口。

## P1：任务详情面板不能真正编辑保存

现象：
- 点击任务行打开详情后，表单字段看起来可改，但保存不会把修改写入数据库。
- 标题字段还是 readonly。

原因：
- `src/renderer/components/TickTick/TaskDetailPanel.tsx` 使用 `defaultValue`，没有受控 state。
- 保存按钮只调用 `onUpdated()`，没有调用 `window.api.updateTickTickTask(...)`。

涉及文件：
- `src/renderer/components/TickTick/TaskDetailPanel.tsx`
- `src/main/services/ticktickService.ts`
- `src/preload/preload.ts`

当前状态：
- 代码已修，待人工/端到端验收。`TaskDetailPanel.tsx` 已改为受控表单（title/due_date/due_time/priority/list_id/note/tags 均用 `useState`），保存调用 `window.api.updateTickTickTask(task.id, ...)`。
- 仍需人工确认：改动关闭再打开可保留、切换清单可跨清单移动。

建议修法：
- 给 title、note、due_date、priority、list_id、tags 等字段加本地 state。
- 保存时调用 `window.api.updateTickTickTask(task.id, payload)`。
- 保存成功后 toast 或刷新列表。

验收：
- 修改任务标题、日期、优先级、清单、备注、标签后关闭再打开仍保留。
- 修改清单后，任务能从旧清单移动到新清单。

## P1：Quick Add 在没有清单时会创建孤儿任务

现象：
- 如果还没有 TickTick 清单，快速添加仍可能提交。
- `list_id` 可能是空字符串或 undefined，数据库里会产生无法在正常清单下显示的任务。

原因：
- `src/renderer/components/TickTick/QuickAddBar.tsx` 用 `defaultListId || lists[0]?.id || ''`。
- `src/main/services/ticktickService.ts:createTickTickTask` 没校验 `list_id` 必须存在。

涉及文件：
- `src/renderer/components/TickTick/QuickAddBar.tsx`
- `src/main/services/ticktickService.ts`
- `src/renderer/components/TickTick/AiPanel.tsx` 也有类似默认清单依赖，需顺手检查。

当前状态：
- 代码已修，待人工/端到端验收。前端 `QuickAddBar.tsx` 与 `AiPanel.tsx` 在 `!lists.length` 时禁用输入/按钮并提示“请先创建清单”；后端 `createTickTickTask` / `updateTickTickTask` 对空或不存在的 `list_id` 抛出可读错误（“请先创建或选择一个清单”/“清单不存在，请刷新后重试”）。
- 仍需人工确认：清空清单后无法创建 list_id 为空的任务，AI 拆解/每日计划路径同样受阻。

建议修法：
- 前端：没有清单时禁用快速添加，提示先创建清单，或自动创建默认“收集箱”清单。
- 后端：`createTickTickTask` 校验 `list_id` 非空且存在；不存在时抛出可读错误。

验收：
- 清空 TickTick 清单后，不能创建 list_id 为空的任务。
- AI 拆解/每日计划接受任务时也不能写入空 list_id。

## P1：TickTick 完成关联复习任务时没有调用真正的同步 IPC（已修复）

状态：已修复。完成/取消完成已收口到 main 侧 `completeTaskWithReviewSync` / `uncompleteTaskWithReviewSync` 统一入口，所有 renderer 入口一致生效。

修复方式：
- `src/main/services/bridgeService.ts` 新增 `completeTaskWithReviewSync` / `uncompleteTaskWithReviewSync`，完成任务后自动调用 `syncTaskCompletedToReview`，取消完成时自动调用 `undoSyncTaskCompleted`。
- `src/main/ipc/registerIpc.ts` 的 `ticktick:tasks:complete` / `ticktick:tasks:uncomplete` 改为调用统一入口。
- `src/renderer/pages/ticktick/TodayPage.tsx` 已移除手工同步调用。
- 自动化测试：`tests/main/bridgeService.test.cjs` 覆盖统一入口 complete/uncomplete 同步与撤销。

验收：
- 完成有关联错题复习的任务后，错题本复习记录真实增加。
- 在“今日待复习/统计/备考监督”里能看到同步效果。

## P1：TickTick 专注计时器结束逻辑存在 stale closure / 状态竞态（已修复）

状态：已修复。计时器状态已收口到 main 侧 `FocusTimerEngine` 单一真源，FocusTimerPage 和 DesktopWidget 均为只读客户端 + 命令入口，不再各自独立推进时间。

现象（已修复）：
- 专注倒计时结束后，可能不能正确进入休息，或休息结束后状态不正确。
- 自动开始休息时可能重复/错乱。
- 主页面和桌面悬浮窗各自维护独立状态机和 interval，状态分叉。

修复方式：
- `src/main/services/focusTimerEngine.ts`：新增 `FocusTimerEngine` 类，管理 `idle/running/paused/break` 状态迁移，main 进程单一 interval 调用 `tick()` 推进时间。
- `src/main/ipc/registerIpc.ts`：`sharedTimerState` 替换为 `FocusTimerEngine` 实例，新增 `timer:start` / `timer:pause` / `timer:reset` / `timer:skipBreak` / `timer:bindTask` / `timer:setConfig` 命令 IPC。
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`：移除本地状态机/interval/localStorage，改为轮询 `getSharedTimerState` + 发送命令。
- `src/renderer/pages/ticktick/DesktopWidget.tsx`：移除独立计时器状态机/interval/localStorage，改为同一轮询 + 命令入口。
- `src/preload/preload.ts` + `src/shared/api.ts`：移除 `setSharedTimerState`，新增 `startSharedTimer` / `pauseSharedTimer` / `resetSharedTimer` / `skipBreakSharedTimer` / `bindTimerTask` / `setTimerConfig`。
- 自动化测试：`tests/main/focusTimerEngine.test.cjs` 覆盖 start/pause/reset/skipBreak/tick 自动迁移/长休息/回调等 11 条用例。

验收：
- 设为 1 分钟专注/1 分钟休息测试完整循环。
- 专注结束只创建一条 focus session。
- 休息结束回到下一轮专注准备状态，轮次正确。
- 主页面和 Widget 显示同一套状态，不再各自独立推进。

## P2：TickTick 设置默认值前后端不一致

现象：
- 前端设置页默认 `autoCreateReviewTasks: true`。
- 后端默认 `autoCreateReviewTasks: false`。
- 首次打开/保存前后的默认行为可能不一致。

原因：
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx` 的 `defaultSettings` 和 `src/main/services/ticktickService.ts` 的 `DEFAULT_TICKTICK_SETTINGS` 不一致。

涉及文件：
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/main/services/ticktickService.ts`

建议修法：
- 统一默认值，最好以后端 `getTickTickSettings()` 返回值为准。
- 前端本地 default 只用于 loading fallback，不应表达不同业务默认。

验收：
- 清空设置后首次打开设置页，显示值和实际自动生成复习任务行为一致。

## P2：“收集箱”目前复用了 TodayPage，不是真正的无日期收集箱

现象：
- 点击收集箱后显示的仍是今天页结构。
- 侧边栏收集箱计数按无日期任务统计，但主内容不是无日期任务列表。

原因：
- `src/renderer/App.tsx` 中 `ttPage === 'inbox'` 直接渲染 `<TodayPage />`。

涉及文件：
- `src/renderer/App.tsx`
- `src/renderer/pages/ticktick/TodayPage.tsx`
- 可新增 `src/renderer/pages/ticktick/InboxPage.tsx`

建议修法：
- 实现 `InboxPage`，使用 `window.api.listTickTickTasks({ includeNoDate: true })` 并过滤 `!due_date && !parent_id`。
- 支持快速添加，默认 due_date 为空。

验收：
- 收集箱只显示无日期任务。
- 给任务设置日期后，它应从收集箱消失。

## P2：TickTickShell 组件重复/未使用，容易导致后续维护分叉

现象：
- `src/renderer/pages/ticktick/TickTickShell.tsx` 已经实现了一套 shell。
- `src/renderer/App.tsx` 又手写了一套几乎相同的 TickTick shell。

风险：
- 修布局或计时器条时可能只改一处，另一处继续坏。

建议修法：
- 要么 App 统一使用 `TickTickShell`，要么删除未使用组件。
- 如果保留 `TickTickShell`，把 layout fix 和常驻计时条都收敛到它里面。

验收：
- `rg "TickTickShell"` 只剩真实使用，不应有死代码。

## P2：TickTick 页面大量错误被静默吞掉，空白时缺少错误提示

现象：
- Today、Sidebar、Settings 等页面大量 `catch {}`。
- 数据库/API 报错时用户只会看到空白或旧数据，不知道哪里坏。

涉及文件：
- `src/renderer/pages/ticktick/TodayPage.tsx`
- `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/renderer/pages/ticktick/CalendarPage.tsx`
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`

建议修法：
- 至少在页面级 `catch` 中设置 error state，并显示可读错误。
- 同时 `console.error` 原始错误，便于 Electron DevTools 排查。
- 用户操作失败用 toast。

验收：
- 模拟 IPC reject 时，页面显示错误提示而不是空白。

## P3：中文显示在部分终端输出中出现乱码

现象：
- PowerShell `Get-Content` 输出源码时出现 mojibake，但应用页面内大多能正确显示中文。

判断：
- 这可能是终端编码读取问题，不一定是源码文件本身已损坏。
- Claude Code 修复前不要盲目批量重编码，避免把正常 UTF-8 文件改坏。

建议：
- 用编辑器或 Node 读取确认文件编码。
- 如果真有源码字符串损坏，再局部修复中文文案。

## 建议整体验证脚本/流程

1. 清理当前 shell 中的 Electron 环境变量：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
```

2. 类型检查和构建：

```bash
npm.cmd run typecheck
npm.cmd run build
```

3. 启动打包版或 dev Electron，逐页点测：
- 错题本首页
- TickTick 今天
- TickTick 日历
- TickTick 收集箱
- 任意清单详情
- 专注计时
- 设置

4. 打包后验证：

```bash
npm.cmd run pack:win
```

5. 双击验证：
- `release/win-unpacked/考研高数错题本.exe`
- `release/考研高数错题本 0.1.0.exe`

