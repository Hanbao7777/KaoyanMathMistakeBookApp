# TickTick Secondary Error Closure Task

## Background

- TickTick 主链路 5 页初始化加载失败的可见错误态已经补齐。
- 当前剩余静默错误点主要集中在第二梯队页面与 Widget/专注计时器：
- `src/renderer/pages/ticktick/EisenhowerPage.tsx`
- `src/renderer/pages/ticktick/KanbanPage.tsx`
- `src/renderer/pages/ticktick/HabitsPage.tsx`
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- 现状包括：
- 初始化加载失败只 `console.error` 或直接无提示
- Widget 的计时器命令 `.catch(() => {})` 完全吞掉
- FocusTimerPage 的共享计时器命令失败没有用户可见反馈

## Goal

- 为第二梯队 TickTick 页面和 Widget/专注计时器补最小可见错误反馈，继续缩小静默错误面。

## Non-Goals

- 不做全局错误边界。
- 不重构 Widget 架构或 FocusTimerEngine。
- 不一次性覆盖所有操作路径。

## Scope

- `EisenhowerPage.tsx`
- `KanbanPage.tsx`
- `HabitsPage.tsx`
- `FocusTimerPage.tsx`
- `DesktopWidget.tsx`
- 如有必要，可复用已有 `src/shared/loadState.ts`
- 如状态明确，可最小同步文档

## Constraints

- 必须先写失败测试，再写生产代码。
- 优先补：
- 初始化加载失败的可见错误态 + 重试
- 关键用户命令失败的 toast 或可见反馈
- 保持现有成功路径和主流程交互尽量不变。

## Proposed Approach

- 对次要页面初始化加载失败，沿用主链路已采用的最小模式：
- `error` state
- 可见错误文案
- `重试` 按钮
- 对 FocusTimerPage / DesktopWidget 的关键命令失败：
- 保留 `console.error`
- 给用户可见反馈，避免纯吞错
- 不追求本轮把每一个 `.catch` 全部消灭，优先处理“用户正在操作却没有任何反馈”的点。

## Risks

- 如果把 Widget 的全部轮询失败都变成高频 toast，可能造成噪音。
- 如果在拖拽、看板移动等操作里过度补反馈，可能把范围拉大。
- 如果把“空状态”与“错误态”混淆，会让用户误判数据状态。

## Acceptance Criteria

- 目标页面初始化加载失败时有可见错误提示。
- 至少有明确重试入口。
- FocusTimerPage / DesktopWidget 的关键命令失败不再纯吞错。
- 成功路径不回退。
- `npm test`、`npm run typecheck`、`npm run build` 通过。

## Task Breakdown

1. 写失败测试，覆盖最小可测错误处理逻辑。
2. 为次要页面补初始化错误态与重试。
3. 为 FocusTimerPage / DesktopWidget 的关键命令失败补可见反馈。
4. 跑测试、typecheck、build。
5. 如文档状态变化，最小同步文档。

## Verification

- 重点代码：
- `src/renderer/pages/ticktick/EisenhowerPage.tsx`
- `src/renderer/pages/ticktick/KanbanPage.tsx`
- `src/renderer/pages/ticktick/HabitsPage.tsx`
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- 共享 helper：
- `src/shared/loadState.ts`
- 验证命令：
- `npm test`
- `npm run typecheck`
- `npm run build`
