# Study Supervisor Tests Design

## Background

当前最小回归套件已经覆盖：

- schema 初始化
- 备份恢复
- 结构化错题导入
- 导入批次删除
- 复习算法
- TickTick 服务边界
- 桥接同步
- 题库作答
- IPC 契约扫描
- migration 升级回归
- knowledge map 导入

但 `studySupervisorService.ts` 仍未纳入测试。这个服务虽然功能面很宽，但当前真正高风险的部分不是基础 CRUD，而是**监督闭环**本身：任务完成、跳过、顺延、每日复盘汇总。这些路径会直接改写 `study_tasks`、`study_sessions`、`daily_reviews`、`study_settings`，属于高价值回归目标。

## Goal

为 `studySupervisorService` 新增一批监督闭环测试，优先覆盖：

- `completeStudyTask()`
- `skipStudyTask()`
- `rolloverOverdueTasks()`
- `saveDailyReview()` / 当天监督汇总写入

## Non-Goals

- 不铺开 `studySupervisorService` 全量 CRUD。
- 不测试 dashboard 聚合、风险总览、复杂风险分级算法。
- 不测试 renderer / IPC / E2E。
- 不测试知识地图、导入服务或 TickTick 侧逻辑。
- 不引入新的测试框架。

## Scope

### In Scope

- service 层监督闭环测试
- 最小监督数据夹具（科目 / 任务 / session / settings）
- 任务完成副作用
- 任务跳过副作用
- 逾期任务顺延副作用
- 每日复盘或每日汇总写入

### Out of Scope

- 完整资料 / 任务 CRUD 面
- dashboard / 风险聚合细节
- UI / IPC / Electron 行为

## Constraints

- 测试必须沿用现有 `tests/main/*.test.cjs` + `node:test` 体系。
- 夹具直接在测试里插入最小监督数据，不引入外部文件样本。
- 首批断言只抓状态转换和核心副作用，不把 dashboard 风险算法绑进测试。
- 若发现真实业务 bug，可最小范围修复，但必须明确区分“测试补洞”与“生产 bug 修复”。

## Proposed Approach

### Approach A — 监督闭环主测（推荐）

围绕 4 个最有价值的服务方法做状态转换测试：

1. `completeStudyTask()`
2. `skipStudyTask()`
3. `rolloverOverdueTasks()`
4. `saveDailyReview()` 或其依赖的每日汇总链

优点：

- 能覆盖真实监督逻辑
- 比全量 CRUD 更接近业务回归风险
- 首批实现成本适中

### Approach B — 先铺 CRUD，再测监督

更平铺，但首批价值偏低。基础 CRUD 更机械，监督闭环才是容易出业务回归的地方。

### Approach C — 全量铺开整个 studySupervisorService

过重，不适合作为第一批。当前应先打穿最核心的状态转换路径。

## Recommended Design

采用 **Approach A**。

### 最小测试夹具

每个测试内按需插入最小监督数据：

- 1 行 `study_settings`
- 1 个默认科目
- 1-2 个 `study_tasks`
- 必要时 1 条 `study_sessions`

### 首批 4 条测试

1. **completeStudyTask()**
   - 任务状态变为“已完成”
   - 写入 `completed_at`
   - 正确写入或累加 `actual_minutes`
   - 可选断言 `completion_quality`

2. **skipStudyTask()**
   - 任务状态变为“已跳过”
   - 写入 `skipped_reason`
   - 写入 `completed_at`

3. **rolloverOverdueTasks()**
   - 逾期且未完成任务顺延到今天
   - `defer_count + 1`
   - 更新 `study_settings.last_rollover_date`

4. **saveDailyReview()` / 当天汇总链**
   - 根据当天任务与学习时长写入 `daily_reviews`
   - 核心断言 `completion_rate`、`total_study_minutes`、`completed_task_count`

## Assertion Strategy

首批断言只抓 4 类核心副作用：

1. **任务状态**
   - `status`
   - `completed_at`
   - `skipped_reason`

2. **时长与进度**
   - `actual_minutes`
   - 必要时 `study_sessions.duration_minutes`

3. **顺延与设置**
   - `task_date`
   - `defer_count`
   - `study_settings.last_rollover_date`

4. **每日复盘汇总**
   - `daily_reviews.completion_rate`
   - `daily_reviews.total_study_minutes`
   - `daily_reviews.completed_task_count`

首批不把这些内容绑进断言：

- dashboard 整体聚合结果
- 材料风险 `riskLevel`
- 科目排名或风险总览

## Risks

- `studySupervisorService` 内部职责较多，若断言范围过大，测试会快速变脆。
- 时间相关逻辑（今天/逾期/last_rollover_date）容易受日期处理影响，需要固定测试日期或稳定构造输入。
- `saveDailyReview()` 可能依赖当天已有任务/学习记录统计，如果夹具不完整，容易误判为实现 bug。

## Acceptance Criteria

- 新增 `studySupervisorService` 测试文件，纳入 `npm test`。
- 至少覆盖：
  - `completeStudyTask()`
  - `skipStudyTask()`
  - `rolloverOverdueTasks()`
  - `saveDailyReview()` / 当天汇总链
- 测试夹具直接在测试中构造，不依赖外部文件。
- 断言聚焦状态转换与核心副作用，不扩大到 dashboard 风险逻辑。
- `npm test` / `npm run typecheck` / `npm run build` 通过。

## Task Breakdown

1. 盘点 `studySupervisorService` 中监督闭环入口及依赖数据表。
2. 设计最小监督数据夹具。
3. 为完成、跳过、顺延、每日复盘分别编写回归测试。
4. 跑全量测试与构建验证无回归。

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- 额外检查新增测试是否仍然只覆盖监督闭环，而没有扩到 dashboard / 风险总览 / UI
