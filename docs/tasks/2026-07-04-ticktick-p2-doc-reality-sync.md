# TickTick P2 Documentation Reality Sync Task

## Background

- 当前 TickTick P2 文档与实际代码状态存在滞后。
- 已确认的代码事实：
- `src/main/services/ticktickService.ts` 的 `DEFAULT_TICKTICK_SETTINGS.autoCreateReviewTasks` 已为 `true`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx` 的默认值也为 `true`
- `src/renderer/pages/ticktick/InboxPage.tsx` 已存在且已实现独立收集箱页面
- `src/renderer/App.tsx` 中 `ttPage === 'inbox'` 已渲染 `InboxPage`
- `src/renderer/App.tsx` 已实际使用 `TickTickShell`
- 因此，现有 P2 中至少三条旧问题已经不再准确：
- 默认值前后端不一致
- 收集箱复用 TodayPage
- TickTickShell 重复/未使用

## Goal

- 把 TickTick P2 文档校准到与当前代码事实一致，只保留真实未完成项。

## Non-Goals

- 不修改任何源码。
- 不顺手处理真正剩余的 P2 实现。
- 不扩展新的路线图范围。

## Scope

- `KNOWN_ISSUES.md`
- `ROADMAP.md`
- `TICKTICK_KNOWN_BUGS.md`

## Constraints

- 只改上述三份文档。
- 必须基于当前代码事实收口，不夸大完成度。
- 如果某项只是“代码已到位但缺人工验收”，要明确写清，不得直接写成完全闭环。

## Proposed Approach

- 把已被代码消化的 3 条 P2 旧问题从“待修复”改成：
- 已修复
- 或从主文档移除、在详单中保留历史说明
- 保留仍真实存在的 P2，例如页面级错误静默吞掉。
- 如有必要，顺手把“当前 P2 重心”改成真实剩余项。

## Risks

- 如果把“代码存在”误写成“产品完全验收通过”，会误导后续优先级。
- 如果删掉过多历史上下文，会降低回溯价值。

## Acceptance Criteria

- 三份文档只更新与上述 3 条过时 P2 相关的状态。
- 不触碰源码。
- `git diff` 范围只包含这三份文档。
- 文案与当前代码事实一致。

## Task Breakdown

1. 复核代码锚点。
2. 更新三份文档的对应 P2 条目。
3. 自审 wording，确认没有误写成超出事实的“完全闭环”。
4. 提供 diff 范围、风险、剩余真实 P2 建议。

## Verification

- 代码锚点：
- `src/main/services/ticktickService.ts`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/renderer/pages/ticktick/InboxPage.tsx`
- `src/renderer/App.tsx`
- 变更范围：
- `git diff -- KNOWN_ISSUES.md ROADMAP.md TICKTICK_KNOWN_BUGS.md`
- `git status --short`
