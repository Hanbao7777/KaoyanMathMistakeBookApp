# TickTick P1 Documentation Sync Task

## Background

- TickTick 的两个 P1 数据完整性问题已经在代码中落地：
- `TaskDetailPanel` 已改为受控表单并调用 `updateTickTickTask(...)`
- Quick Add / AI 创建任务已在前后端阻止无清单孤儿任务
- 当前 `KNOWN_ISSUES.md`、`ROADMAP.md`、`TICKTICK_KNOWN_BUGS.md` 仍保留旧的“待修复”表述，与实现状态不一致。

## Goal

- 将 TickTick P1 文档收口到与当前代码一致的状态，同时保留“待人工验收”和未完成项的边界。

## Non-Goals

- 不修改任何源码、测试、CI、构建脚本。
- 不顺手处理其它 P1/P2/Phase 2 条目。
- 不把“代码已修”误写成“完全闭环”。

## Scope

- 更新 `KNOWN_ISSUES.md`
- 更新 `ROADMAP.md`
- 更新 `TICKTICK_KNOWN_BUGS.md`

## Constraints

- 只允许修改上述三份文档。
- 口径必须区分：
- `代码已修，待人工/端到端验收`
- `仍待修复`
- 文案必须与当前代码事实一致，不夸大完成度。

## Proposed Approach

- 先复核现有代码行为对应的真实状态。
- 仅收口以下两项：
- 任务详情面板真正编辑保存
- 无清单时阻止 Quick Add / AI 创建孤儿任务
- 在主文档中改为摘要口径，在 `TICKTICK_KNOWN_BUGS.md` 中保留更完整上下文。

## Risks

- 如果把“代码已修”写成“已完全闭环”，会误导后续验收和优先级判断。
- 如果误改相邻 P1/P2 条目，会让路线图失真。

## Acceptance Criteria

- 三份文档只更新上述两个 P1 条目的状态描述。
- 明确写出“代码已修，待人工/端到端验收”或等价限定语。
- 不触碰其它未完成条目的优先级和状态。
- `git diff` 中不出现源码或其它文档改动。

## Task Breakdown

1. 复核代码锚点与当前状态。
2. 更新三份文档的对应 P1 条目。
3. 自审 wording，确认未误写成“完全闭环”。
4. 提供 `git diff` 范围、风险与后续建议。

## Verification

- 代码锚点复核：
- `src/renderer/components/TickTick/TaskDetailPanel.tsx`
- `src/renderer/components/TickTick/QuickAddBar.tsx`
- `src/renderer/components/TickTick/AiPanel.tsx`
- `src/main/services/ticktickService.ts`
- 变更范围复核：
- `git diff -- KNOWN_ISSUES.md ROADMAP.md TICKTICK_KNOWN_BUGS.md`
- `git status --short`
