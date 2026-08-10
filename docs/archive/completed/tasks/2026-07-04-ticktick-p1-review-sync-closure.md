# TickTick P1 Review Sync Closure Task

## Background

- 当前 TickTick “完成关联复习任务时同步错题本复习记录”并不是统一行为。
- `TodayPage.tsx` 在 renderer 侧手工调用：
- `completeTickTickTask(...)`
- `getTickTickTaskBridges(...)`
- `syncTickTickTaskCompletedToReview(...)`
- `undoReviewTaskSync(...)`
- 但其它入口也能完成/取消完成任务：
- `ListDetailPage.tsx`
- `InboxPage.tsx`
- `KanbanPage.tsx`
- `EisenhowerPage.tsx`
- `DesktopWidget.tsx`
- 这些入口只调用 `completeTickTickTask(...)` / `uncompleteTickTickTask(...)`，不会触发 bridge sync。
- 结果是：同一条 `auto_review` / `sync_review` 任务，在不同页面完成，副作用不一致。

## Goal

- 把 TickTick 关联复习同步收口成“所有完成/取消完成入口一致生效”的单一行为。

## Non-Goals

- 不处理专注计时器竞态。
- 不顺手重构 TickTick 全部页面。
- 不扩展新的 bridge 类型或新的同步规则。

## Scope

- 统一 `ticktick:tasks:complete` / `ticktick:tasks:uncomplete` 的桥接副作用触发点。
- 删除 renderer 页面里只属于该副作用的重复逻辑。
- 增加最小自动化测试覆盖“非 TodayPage 入口也会同步/撤销同步”。
- 如有必要，同步最小文档状态。

## Constraints

- 必须先写失败测试，再写生产代码。
- 生产代码改动应尽量集中在 main / IPC 单一真源，避免在每个页面补丁式复制。
- 不允许保留“双重同步源”（renderer 手工同步 + main 自动同步）导致行为分叉。
- 不改无关 P1/P2 条目。

## Proposed Approach

- 把完成/取消完成后的 review sync 收口到 main 侧统一入口，优先考虑 IPC `ticktick:tasks:complete` / `ticktick:tasks:uncomplete`。
- 让所有 renderer 入口继续只调用完成/取消完成 API，不再自己判断 bridge 并手工同步。
- 用测试证明：
- 通过统一入口完成带 `sync_review` bridge 的任务，会写 review log
- 再次取消完成，会撤销对应同步
- 不带 bridge 的普通任务不会误写 review log

## Risks

- 如果同时保留 TodayPage 手工同步和 main 自动同步，会出现重复调用，虽然现有去重可能兜底，但职责仍然错误。
- 如果撤销同步条件写错，可能删除错误的当天 review log。
- 如果在 `ticktickService.ts` 直接反向依赖 `bridgeService.ts`，可能引入不必要循环依赖。

## Acceptance Criteria

- 任意 UI 入口调用 `completeTickTickTask`，只要该任务存在 `sync_review` bridge，就会统一触发复习同步。
- 任意 UI 入口调用 `uncompleteTickTickTask`，会统一撤销对应同步。
- `TodayPage` 不再手工调用 `getTickTickTaskBridges` / `syncTickTickTaskCompletedToReview` / `undoReviewTaskSync`。
- 新增或更新测试能在修复前失败、修复后通过。
- `npm test`、`npm run typecheck`、`npm run build` 通过。

## Task Breakdown

1. 写失败测试，覆盖统一入口的 complete / uncomplete 同步行为。
2. 定位最小单一真源，优先收口到 main IPC 层。
3. 实现完成/取消完成后的统一 bridge sync。
4. 删除 `TodayPage` 的重复同步逻辑。
5. 跑测试、typecheck、build。
6. 如状态变化明确，同步最小文档口径。

## Verification

- 重点代码：
- `src/main/ipc/registerIpc.ts`
- `src/main/services/bridgeService.ts`
- `src/main/services/ticktickService.ts`
- `src/renderer/pages/ticktick/TodayPage.tsx`
- 重点测试：
- `tests/main/bridgeService.test.cjs`
- 如需新增，放在 `tests/main/` 下并覆盖统一入口行为
- 验证命令：
- `npm test`
- `npm run typecheck`
- `npm run build`
