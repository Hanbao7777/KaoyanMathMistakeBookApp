# Migration Upgrade Tests Design

## Background

当前最小回归套件已经覆盖全新数据库初始化、备份恢复、结构化导入、导入批次删除、复习算法、TickTick 服务边界、桥接同步、题库作答与 IPC 契约扫描，也已经接入最小 GitHub Actions CI。

但测试体系仍有一个高风险缺口：**数据库 migration 升级路径** 还没有自动化回归。现状只验证“全新数据库按当前 schema 初始化成功”，没有验证“旧版本数据库带真实旧数据升级到当前 schema 后仍可用且不丢数据”。

## Goal

为主进程数据库层新增一批 migration 升级回归测试，覆盖“最小旧库快照（错题本 + TickTick）升级到当前 schema”这一真实风险路径。

## Non-Goals

- 不重建完整历史版本谱系。
- 不引入版本化 migration 框架重构。
- 不测试 renderer、Electron UI 或端到端流程。
- 不测试导入服务、知识地图导入或 study supervisor。
- 不提交二进制旧 `.db` fixture 文件到仓库。

## Scope

### In Scope

- 在 `node:test` 体系下新增一组 migration 升级回归测试。
- 用测试代码动态构造“旧 schema + 旧数据”数据库状态。
- 旧数据同时覆盖：
  - 1-2 条错题数据
  - 至少 1 条复习相关数据
  - 1 个 TickTick 清单
  - 1-2 个 TickTick 任务
- 验证升级后的结构完整性与旧数据保留情况。

### Out of Scope

- 多版本链式升级矩阵。
- 真实历史数据库文件样本管理。
- renderer / Electron E2E。
- 知识地图导入与 study supervisor 测试。

## Constraints

- 测试必须沿用现有 `tests/main/*.test.cjs` + `node:test` 体系。
- 旧库 fixture 通过测试代码动态创建，不提交二进制数据库文件。
- 测试必须复用现有 main 测试环境与临时目录清理模式。
- 只验证“升级到当前 schema 后仍可用”，不要求重建历史 migration 文档。
- 断言必须区分“结构补齐成功”和“旧数据保留成功”两类结果。

## Proposed Approach

### Approach A — 动态旧库构造 + 当前迁移逻辑回归（推荐）

在测试中手工创建一套“比当前 schema 更旧”的最小数据库结构，故意缺失当前新增的关键列和索引；插入少量旧错题、复习、TickTick 数据；然后调用当前数据库初始化/迁移入口，让现有迁移逻辑自动把旧库补到当前版本。最后验证：

- 旧数据仍然可查询
- 当前关键列已补齐
- 当前关键索引已存在
- 至少 1-2 个核心服务层读取不报错

这是首批性价比最高的方案：无二进制 fixture、无过度历史建模、回归信号最直接。

### Approach B — 提交静态旧 `.db` fixture`

把一个旧数据库文件直接放进测试夹具目录，再在测试中复制后升级。

优点是更接近“真实旧库”，缺点是：

- 二进制样本难 review
- fixture 演进不透明
- schema 变化后维护成本更高

当前不推荐。

### Approach C — 每个历史迁移版本单独回放

对每个历史迁移节点都建一套旧库并逐步回放。

这是长期理想形态，但当前仓库没有完善的版本化 migration 体系；现在这样做会把“补测试”放大成“迁移框架重建”，超出本轮范围。

## Recommended Design

采用 **Approach A**。

首批测试只做一个“最小但真实”的旧库场景：

- 旧 `questions` 表含基础错题记录
- 旧 `review_logs` 表含至少 1 条历史复习记录
- 旧 `ticktick_lists` / `ticktick_tasks` 含最小任务数据
- 旧结构刻意不包含当前新增的一部分关键列与索引

升级后验证四类结果：

1. **数据保留**
   - `questions`、`review_logs`、`ticktick_lists`、`ticktick_tasks` 旧记录仍存在
   - 核心字段值未丢失

2. **结构补齐**
   - 当前关键列已存在，尤其是 TickTick 当前服务依赖字段

3. **索引补齐**
   - 当前关键索引已存在

4. **服务层可读**
   - 升级后至少跑一两个核心读取路径，不因旧库升级而报错

## Risks

- 如果当前 migration 逻辑假设数据库总是“全新初始化”，这批测试可能暴露真实 bug，而不是一次性通过。
- 旧 schema 选得太旧，会把任务放大成兼容多代历史结构；选得太新，又可能测不到真实风险。
- 服务层读取断言选得过重，会把 migration 测试耦合到无关业务逻辑。

## Acceptance Criteria

- 新增 migration 升级测试文件，纳入当前 `npm test`。
- 测试通过动态构造旧库而非提交二进制 `.db` fixture。
- 测试同时覆盖错题本与 TickTick 的最小旧数据。
- 测试断言同时覆盖：
  - 数据保留
  - 关键列补齐
  - 关键索引存在
  - 核心读取不报错
- 不扩大到知识地图导入、study supervisor、renderer 或 E2E。

## Task Breakdown

1. 盘点当前 migration 入口和 schema 补齐逻辑。
2. 设计“最小旧库”结构，明确哪些列/索引故意缺失。
3. 在现有 main 测试环境中新增 migration 测试文件。
4. 构造旧库、插入旧数据、触发当前迁移。
5. 增加结构、数据、索引、服务层读取断言。
6. 跑 `npm test` / `npm run typecheck` / `npm run build` 验证无回归。

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- 额外检查新增测试是否只覆盖 migration 升级路径，没有混入无关服务测试
