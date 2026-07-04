# TickTick Page Error State Closure Task

## Background

- 当前 TickTick 还存在真实 P2：页面级错误被静默吞掉，用户只会看到空白、旧数据或无限“加载中”。
- 已确认的高价值入口：
- `src/renderer/pages/ticktick/TodayPage.tsx`
- `src/renderer/pages/ticktick/InboxPage.tsx`
- `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/renderer/pages/ticktick/CalendarPage.tsx`
- 当前问题形态包括：
- `catch {}` 直接吞错
- 只 `console.error` 但没有用户可见提示
- 失败后直接 `setLoading(false)`，页面没有 error state

## Goal

- 给 TickTick 主链路页面补上最小可见错误状态，让加载失败时用户看到明确提示而不是空白或旧数据。

## Non-Goals

- 不做全局错误边界体系。
- 不重构所有 TickTick 页面。
- 不顺手统一所有 toast 风格或文案系统。

## Scope

- `TodayPage.tsx`
- `InboxPage.tsx`
- `TickTickSidebar.tsx`
- `TickTickSettingsPage.tsx`
- `CalendarPage.tsx`
- 如有必要，最小补充共享小组件或帮助函数
- 如状态明确收口，可最小同步对应文档

## Constraints

- 必须先写失败测试，再写生产代码。
- 优先补“加载失败可见错误 + 重试入口”，不要把范围扩成完整设计系统。
- 保持现有成功路径和页面结构尽量不变。
- 用户操作失败仍可继续使用 toast；页面初始化失败需要可见 error state。

## Proposed Approach

- 为每个目标页面增加最小 `error` state。
- 初始化加载失败时：
- 继续 `console.error`
- 设置可读错误文案
- 渲染错误态，而不是空白/旧数据
- 提供最小“重试”按钮，重新触发 load。
- 对于 `TickTickSidebar` 这类侧栏加载失败，可降级显示基础导航并附带错误提示，而不是完全静默。

## Risks

- 如果把“空列表”与“加载失败”混在一起，会让用户误判数据状态。
- 如果在多个页面复制太多错误态 UI，后续维护会变差；但本轮不宜过度抽象。
- 如果只加 toast、不加页面级 error state，问题本质仍未解决。

## Acceptance Criteria

- 目标页面初始化加载失败时，都有用户可见错误提示。
- 至少提供一个明确重试入口。
- 成功加载时原有正常页面行为不回退。
- 新增测试在修复前失败、修复后通过。
- `npm test`、`npm run typecheck`、`npm run build` 通过。

## Task Breakdown

1. 写失败测试，覆盖目标页面的错误态渲染或最小可测逻辑。
2. 给目标页面补 `error` state 与重试入口。
3. 保持已有成功路径和操作型 toast 不变。
4. 跑测试、typecheck、build。
5. 如文档状态发生变化，最小同步文档。

## Verification

- 重点代码：
- `src/renderer/pages/ticktick/TodayPage.tsx`
- `src/renderer/pages/ticktick/InboxPage.tsx`
- `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/renderer/pages/ticktick/CalendarPage.tsx`
- 测试：
- 在适合的最小层新增页面错误态相关测试
- 验证命令：
- `npm test`
- `npm run typecheck`
- `npm run build`
