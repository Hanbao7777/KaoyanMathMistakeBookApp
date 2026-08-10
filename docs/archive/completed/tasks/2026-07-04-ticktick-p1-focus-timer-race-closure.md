# TickTick P1 Focus Timer Race Closure Task

## Background

- 当前 TickTick 专注计时器至少有两套独立状态机：
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- 两边都各自维护：
- `status`
- `secondsLeft`
- `totalSeconds`
- `completedSessions`
- `sessionStartTime`
- 各自起自己的 `setInterval`
- `FocusTimerPage` 还额外维护 `breakTimeoutRef`
- main 侧虽然有 `sharedTimerState`（`timer:getState` / `timer:setState`），但当前表现是“双方都写 shared state，小窗不从 shared state 恢复，页面也不是以 shared state 为单一真源”。
- 结果是：
- 页面和小窗可能各自推进计时，状态分叉
- break / skip / pause / resume 的时序容易发生竞态
- 文档里标注的 “stale closure / 状态竞态” 本质是多状态源 + 多时钟源问题

## Goal

- 把 TickTick 专注计时器收口为单一状态源，消除页面与小窗之间的竞态和分叉。

## Non-Goals

- 不重做错题本模式的旧 `App.tsx` 学习计时器体系。
- 不实现白噪音真实音频能力。
- 不顺手重构 TickTick 全部页面结构。

## Scope

- 统一 TickTick 专注计时器在主页面和 Desktop Widget 间的状态来源。
- 消除重复 interval / timeout 导致的双推进风险。
- 为核心状态迁移增加最小自动化测试。
- 如状态明确变化，同步最小文档口径。

## Constraints

- 必须先写失败测试，再写生产代码。
- 优先选择“单一真源 + 渲染层只读/发命令”的收口方案。
- 不允许保留两个都能独立推进时间的状态机。
- 不扩 scope 到 UI 美化或无关架构重写。

## Proposed Approach

- 让 TickTick 专注计时器以一处共享状态为唯一可信来源。
- 页面与小窗只做两类事：
- 读取共享状态并渲染
- 发送 start / pause / reset / skip 之类命令
- 避免在两个 renderer 里都各自用 interval 推导真实时间。
- 如果现有 `sharedTimerState` 能承载需求，优先在该通道上补齐“读 + 写 + 迁移”；否则在不破坏现有 IPC 形状的前提下做最小扩展。

## Risks

- 如果只修 `FocusTimerPage` 的闭包，不处理 Widget 的独立状态机，竞态还会存在。
- 如果恢复逻辑和运行逻辑混用旧 `localStorage` 状态，可能继续出现双恢复或幽灵 session。
- 如果 break 结束和 skip break 没统一到同一状态迁移入口，仍可能出现重复推进轮次。

## Acceptance Criteria

- TickTick 主页面与 Desktop Widget 显示同一套专注计时状态，不再各自独立推进。
- start / pause / reset / skip break / 自动进入 break / break 结束后的轮次推进都通过统一状态迁移生效。
- 不再存在页面一套、小窗一套的独立 interval 推进。
- 新增测试在修复前失败、修复后通过。
- `npm test`、`npm run typecheck`、`npm run build` 通过。

## Task Breakdown

1. 写失败测试，覆盖共享计时状态的核心迁移。
2. 明确唯一状态源与命令入口。
3. 收口 `FocusTimerPage` 和 `DesktopWidget` 的计时推进逻辑。
4. 清理旧的重复恢复/推进逻辑。
5. 跑测试、typecheck、build。
6. 如状态已明确收口，同步最小文档。

## Verification

- 重点代码：
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- `src/main/ipc/registerIpc.ts`
- 如需新增/调整：
- `src/preload/preload.ts`
- `src/shared/api.ts`
- 测试：
- 优先在 `tests/main/` 或适合的最小可测层新增共享状态/命令测试
- 验证命令：
- `npm test`
- `npm run typecheck`
- `npm run build`
