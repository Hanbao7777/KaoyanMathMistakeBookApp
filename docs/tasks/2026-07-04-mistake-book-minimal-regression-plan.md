# 错题本主链路最小回归方案任务

## Background

错题本主线当前剩余的 P0 之一，是 renderer / Electron 页面主链路缺乏自动化回归。

现状已经确认：

- 当前测试集中在 `tests/main/` 与 `tests/ipc/`
- `tests/renderer/` 与 `tests/e2e/` 均不存在
- 现有 CI 仅覆盖 `npm test` / `typecheck` / `build`
- 仓库已验证一种轻量模式：将可复用的页面逻辑下沉到 `src/shared`，再用 Node 内置 `node:test` 做回归

因此本轮目标不是直接补齐全量 UI 测试，而是先定义“最小可落地的主链路回归方案”和首批落地点。

## Goal

产出错题本主链路最小回归方案，明确首批应该覆盖的页面链路、推荐测试方式、首批 shared 化落地点与执行顺序。

## Non-Goals

- 不直接实现完整 renderer 测试框架
- 不引入 Playwright / Cypress / RTL / jsdom 等新依赖
- 不修改业务功能代码
- 不展开 TickTick 回归规划

## Scope

- 错题本主链路页面的回归缺口盘点
- “shared 逻辑下沉 + node:test”可行性判断
- 首批测试落地点建议
- 后续是否需要更重 UI/E2E 框架的判断边界

## Constraints

- 方案必须贴合当前仓库，不依赖新框架前提
- 先覆盖高风险、高收益链路，不追求全量
- 不能把“方案”写成空泛原则，必须落到页面/逻辑点
- 只做错题本主线，不含 TickTick

## Proposed Approach

1. 盘点错题本主链路中最值得先加自动回归的页面链路。
2. 区分：
   - 可下沉为 `src/shared` 纯逻辑并用 `node:test` 覆盖的部分
   - 仍需人工/Electron 验收的部分
3. 定义首批 2-4 个落地点，保证每个点都能解释“为什么先做它”。
4. 给出执行顺序，作为后续实现任务的派发依据。

## Risks

- 如果方案过大，会重新演变成“搭完整测试框架”的高成本任务
- 如果方案过小，无法对主线改动形成真实保护
- 如果不区分纯逻辑与 UI 交互，会把 node:test 用到不合适的地方

## Acceptance Criteria

- 明确首批回归范围
- 明确推荐测试方式
- 明确哪些暂时继续保留人工验收
- 方案可直接拆成后续实现任务

## Task Breakdown

1. 盘点主链路页面和关键行为
2. 筛选首批自动回归落地点
3. 定义测试方式与执行顺序
4. 标记仍需人工验收的缺口

## Verification

- 对照现有 `tests/` 目录与 `src/renderer/pages/` 主线页面
- 对照已存在的 `src/shared/loadState.ts` + `tests/main/loadState.test.cjs` 模式

## 方案结果（2026-07-04，基于当前仓库真实状态）

### 1. 主链路高风险行为盘点

通过逐页核对 `src/renderer/pages/` 下 15 个非 TickTick 页面，识别出以下高频纯逻辑点（当前内联在 renderer 中、未测试、且跨页面重复）：

| 逻辑点 | 当前位置 | 重复情况 | 风险 |
|--------|----------|----------|------|
| `isDue(q)` / `isWeak(q)` | LibraryPage, StatsPage | 2 处重复，且 StatsPage 版本缺 `|| 0` 空值保护 | 过滤/统计错误 |
| `masteryTone(level)` / `scoreTone(score)` / `masteryToScore(level)` | DashboardPage, ReviewPage, StatsPage, KnowledgeMapPage, DetailPage | 4+ 处重复 | 显示不一致 |
| `hasActiveFilters(f)` / `activeFilterBadges(f)` | LibraryPage | 唯一但无测试 | 过滤器状态错误 |
| `accuracy(stats)` / undo stat rollback | ReviewPage | 唯一，undo 逻辑非平凡（5 秒倒计时回滚 counter） | 复习统计回滚错误 |
| `filterKnowledgeTree(nodes, query, ...)` | KnowledgeMapPage | 唯一，递归树过滤 | 搜索/过滤遗漏节点 |

### 2. 首批 3 个落地点

#### 落地点 1：错题过滤/弱项判定 helpers

- **目标文件**：`src/shared/questionFilters.ts`
- **测试文件**：`tests/main/questionFilters.test.cjs`
- **提取内容**：
  - `isDue(question)` — 日期字符串比较，统一空值保护
  - `isWeak(question)` — mastery 判定 + wrong/no_idea counter 判定，统一 `|| 0` 保护
  - `hasActiveFilters(filters)` — 全字段空值检查
  - `activeFilterBadges(filters)` — badge 列表生成
  - `computeQuestionSummary(questions)` — unmastered / weak / due 计数
- **来源页面**：LibraryPage + StatsPage（消除重复 + 修复 StatsPage 的 NaN 风险）
- **测试覆盖**：空值/undefined 字段、边界日期、空过滤器、badge 生成、summary 计数
- **为什么先做**：两个页面各有一份 `isWeak`，StatsPage 版本缺 `|| 0` 保护有 NaN 风险；过滤逻辑是错题列表和统计页的核心，回归价值最高

#### 落地点 2：掌握度显示映射

- **目标文件**：`src/shared/masteryDisplay.ts`
- **测试文件**：`tests/main/masteryDisplay.test.cjs`
- **提取内容**：
  - `masteryToScore(level)` — 掌握度 → 数值分数
  - `scoreToTone(score)` — 分数 → CSS tone
  - `masteryToTone(level)` — 掌握度 → CSS tone
  - `masteryBadgeClass(level)` — 掌握度 → badge CSS class
  - `difficultyBadgeClass(difficulty)` — 难度 → badge CSS class
- **来源页面**：DashboardPage / ReviewPage / StatsPage / KnowledgeMapPage / DetailPage（5+ 处重复）
- **测试覆盖**：所有 mastery level 映射、null/undefined score、边界值
- **为什么第二**：重复面最广（5+ 处），但单个映射出错只影响显示色调，不如过滤逻辑致命

#### 落地点 3：复习会话统计计算

- **目标文件**：`src/shared/reviewSession.ts`
- **测试文件**：`tests/main/reviewSession.test.cjs`
- **提取内容**：
  - `computeAccuracy(stats)` — correct/total 百分比，含除零保护
  - `rollbackReviewStat(question, result)` — undo 时回滚 correct/wrong/no_idea counter
  - `filterReviewKnowledgeStats(stats, keyword, onlyDue, onlyWeak)` — 知识点复习过滤
- **来源页面**：ReviewPage
- **测试覆盖**：accuracy 除零、undo 回滚 counter 正确性、knowledge filter 组合
- **为什么第三**：undo 逻辑只有一处但非平凡（5 秒倒计时回滚 counter），一旦出错用户看到错误统计且不易察觉

### 3. 保留人工/Electron 验收的部分

以下内容现阶段不应勉强 shared 化，保留人工/Electron 验收：

| 保留项 | 原因 |
|--------|------|
| 页面 mount → IPC → 渲染 | 依赖 Electron IPC + React 生命周期，node:test 无法覆盖 |
| 图片上传/文件选择 | 依赖 `dialog.showOpenDialog`，已有 main 层测试覆盖 service 侧 |
| ReactFlow 图谱渲染 | 纯 DOM/SVG 渲染，无纯逻辑可提取 |
| Modal 确认交互 | UI 交互流，无纯逻辑 |
| ReviewPage 键盘快捷键 | 依赖 DOM event target 判断 |
| `buildFlowElements` (KnowledgeMapPage) | 虽然 pure，但输出结构耦合 ReactFlow 内部 schema，提取后维护成本高于价值 |

### 4. 执行顺序

1. **落地点 1**（questionFilters）— 最高风险，消除重复 + 修复 NaN
2. **落地点 2**（masteryDisplay）— 最广重复，统一显示映射
3. **落地点 3**（reviewSession）— 非平凡 undo 逻辑，防止统计回滚错误

每个落地点可独立拆为子任务：提取 shared 模块 → 写 node:test 测试 → 替换 renderer 引用 → 跑 `npm test` / `typecheck` / `build`。
