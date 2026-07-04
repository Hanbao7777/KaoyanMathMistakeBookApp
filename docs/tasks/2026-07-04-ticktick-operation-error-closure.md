# TickTick 剩余操作失败反馈收口任务

## Background

前一轮已经完成主链路与第二梯队页面的初始化错误态收口，以及 FocusTimerPage / DesktopWidget 计时器命令失败的 toast 可见化。

当前仍有少量 TickTick 操作路径在失败时只 `console.error(...)` 或静默吞掉，用户侧无反馈，问题定位和验收都不完整。

## Goal

把剩余 TickTick 主路径里的“操作失败仅写日志/静默吞掉”改为用户可见反馈，并同步已知问题与路线图状态。

## Non-Goals

- 不处理错题本模式的非 TickTick 异常路径
- 不重构 TickTick 页面结构
- 不新增通用错误基础设施
- 不处理 Electron 打包、端到端自动化或新功能

## Scope

- `src/renderer/pages/ticktick/CalendarPage.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- `src/renderer/pages/ticktick/InboxPage.tsx`
- `KNOWN_ISSUES.md`
- `ROADMAP.md`
- `TICKTICK_KNOWN_BUGS.md`

## Constraints

- 仅收口 TickTick 剩余操作路径，不扩大到全仓库静默错误治理
- 保持现有 UI 结构与交互风格，优先复用现有 `runLoad` / `runCommand` / toast 模式
- 文档描述必须和代码真实状态一致
- 完成后必须跑 `npm test`、`npm run typecheck`、`npm run build`

## Proposed Approach

1. 为 Calendar 的周/日视图加载失败补充可见错误反馈和重试入口，避免只有控制台日志。
2. 为 DesktopWidget 的数据加载、任务完成、快速添加失败补充 toast 或页面级反馈。
3. 为 Inbox 的任务完成/取消完成失败补充 toast 反馈。
4. 评估 FocusTimerPage 中仍存在的静默轮询/初始化 catch，若能在不引入提示噪声的前提下改进则收口；若不适合本轮收口，在文档中明确保留原因。
5. 同步三份状态文档，明确本轮关闭了哪些剩余 silent error surface，哪些故意保留。

## Risks

- 轮询类失败如果直接 toast，可能造成提示刷屏
- Widget 场景空间有限，错误提示过多会影响使用
- Calendar 的 week/day 视图当前是次级功能，补反馈时不能破坏现有视图切换

## Acceptance Criteria

- Calendar 周视图和日视图加载失败时，用户能看到明确失败反馈，而不是只留控制台日志
- DesktopWidget 的 `loadData` / `completeTask` / `addTask` 失败时，用户能获得可见反馈
- Inbox 切换任务完成状态失败时，用户能获得可见反馈
- 不引入轮询型 toast 刷屏
- `KNOWN_ISSUES.md`、`ROADMAP.md`、`TICKTICK_KNOWN_BUGS.md` 与代码状态一致
- `npm test`、`npm run typecheck`、`npm run build` 全部通过

## Task Breakdown

1. 盘点本轮目标文件中的剩余 silent catch / console-only 操作路径
2. 在不制造提示噪声的前提下补充可见反馈
3. 人工检查文档措辞，避免把“部分收口”写成“完全解决”
4. 跑测试与构建
5. 自审并输出剩余风险

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- 代码审查确认没有把高频轮询失败改成持续刷 toast
