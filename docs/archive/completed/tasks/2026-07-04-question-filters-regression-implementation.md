# Question Filters 最小回归实现任务

## Background

错题本主链路最小回归方案已确定，首个落地点是“错题过滤/弱项判定 helpers”。

当前确认的问题：

- `LibraryPage.tsx` 与 `StatsPage.tsx` 各自内联了 `isDue()` / `isWeak()` 逻辑
- `StatsPage.tsx` 的 `isWeak()` 缺少 LibraryPage 中已有的 `|| 0` 空值保护
- `LibraryPage.tsx` 还内联了 `hasActiveFilters()` / `activeFilterBadges()`
- 这些逻辑目前无自动化回归

## Goal

提取错题过滤与筛选状态 helpers 到 `src/shared/questionFilters.ts`，补 Node 内置测试，并让 `LibraryPage` / `StatsPage` 复用同一份逻辑。

## Non-Goals

- 不处理 `masteryDisplay` 或 `reviewSession`
- 不引入新测试框架
- 不做页面结构重构
- 不扩展到 TickTick

## Scope

- `src/shared/questionFilters.ts`（新增）
- `src/renderer/pages/LibraryPage.tsx`
- `src/renderer/pages/StatsPage.tsx`
- `tests/main/questionFilters.test.cjs`（新增）

## Constraints

- 只做“提取共享逻辑 + 替换调用 + 补测试”
- 保持现有页面行为不变，除修复 `StatsPage` 的空值保护差异
- 测试方式沿用现有 `dist/main/shared/*.js` + `node:test`
- 不顺手改别的页面

## Proposed Approach

1. 新增 `src/shared/questionFilters.ts`，收口以下逻辑：
   - `isDue(questionOrDate)`
   - `isWeak(question)`
   - `hasActiveFilters(filters)`
   - `activeFilterBadges(filters)`
   - `computeQuestionSummary(questions)`
2. 用 `LibraryPage` / `StatsPage` 改为引用 shared helpers。
3. 新增 `tests/main/questionFilters.test.cjs`，覆盖空值、边界日期、badge、summary 计数。

## Risks

- `QuestionFilters` 的 badge 逻辑若改写不慎，可能改变 LibraryPage 当前展示顺序
- `isDue()` 若处理参数方式不兼容，可能影响待复习统计
- shared 提取若混入页面文案，会导致复用边界变差

## Acceptance Criteria

- `LibraryPage` / `StatsPage` 不再各自维护重复的 `isDue` / `isWeak`
- `StatsPage` 的弱项判定补齐空值保护
- `tests/main/questionFilters.test.cjs` 覆盖首批关键边界
- `npm test`、`npm run typecheck`、`npm run build` 通过

## Task Breakdown

1. 提取 shared helpers
2. 替换两个页面的本地实现
3. 编写 node:test 测试
4. 跑验证并自审

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
