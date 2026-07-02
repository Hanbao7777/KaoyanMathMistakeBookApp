# Knowledge Map Import Tests Design

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

但 `knowledgeMapService.ts` 仍未纳入测试，尤其是**知识地图导入链路**还没有自动化回归。这个链路直接写入 `textbooks`、`knowledge_points`、`import_batches`、`import_batch_items`，属于数据安全相关边界，风险高于一般展示查询。

## Goal

为 `knowledgeMapService` 新增一批导入测试，优先覆盖：

- 用户手动导入 `knowledge_map_import.zip`
- 内置 `knowledge_map_seed.zip` 种子导入 smoke

## Non-Goals

- 不测试知识点树查询、复习题筛选、知识点统计等查询接口。
- 不测试 PDF 打开、PDF 绑定、shell/electron 行为。
- 不测试重匹配 `rematchKnowledgePoints()`。
- 不做 renderer / IPC / E2E。
- 不提交二进制 zip fixture 到仓库。

## Scope

### In Scope

- `importKnowledgeMapZip()` 的 service 层测试
- `seedImportKnowledgeMap()` 的 service 层 smoke 测试
- 动态生成最小 zip 导入包
- 导入成功路径与关键失败路径
- 导入批次相关落库断言

### Out of Scope

- 查询类 API
- PDF / shell 行为
- 知识点重匹配
- renderer / Electron E2E

## Constraints

- 测试必须沿用现有 `tests/main/*.test.cjs` + `node:test` 体系。
- zip fixture 必须在测试中动态生成，不提交二进制样本。
- 手动导入是主测试链；种子导入只做 smoke，不重复铺满全部错误分支。
- 断言必须同时覆盖业务数据表和导入批次表。
- 只测 service 层，不扩大到 IPC 或页面。

## Proposed Approach

### Approach A — 动态 zip fixture + 手动导入主测 + 种子导入 smoke（推荐）

在测试中动态生成最小 `knowledge_map_import.zip`：

- `textbooks.json`
- `knowledge_points.json`

然后直接调用 `importKnowledgeMapZip()`，验证导入成功与错误分支。对种子导入则单独在临时 resources 目录下生成一个最小 `knowledge_map_seed.zip`，调用 `seedImportKnowledgeMap()` 做 smoke。

优点：

- 无二进制 fixture
- 与现有结构化导入测试风格一致
- 首批成本低但覆盖导入主风险

### Approach B — 手动导入和种子导入都做完整矩阵

覆盖最全，但首批会有较多重复断言。当前不需要两条链路同时铺满 happy/error 组合。

### Approach C — 只测种子导入

实现最省，但不能覆盖用户真实上传 zip 的主风险。当前不推荐。

## Recommended Design

采用 **Approach A**。

### 手动导入主链

首批覆盖 3 类用例：

1. **happy path**
   - 最小 `textbooks.json` + `knowledge_points.json`
   - 成功导入教材与父子两层知识点
   - 生成对应 `knowledge_map` 导入批次与批次明细

2. **缺文件**
   - 缺 `textbooks.json`
   - 或缺 `knowledge_points.json`
   - 应抛出明确错误

3. **格式错误**
   - `knowledge_points.json` 不是数组
   - 应抛出明确错误

### 种子导入 smoke

只做 1 条最小成功路径：

- 在临时 resources 目录放一个最小 `knowledge_map_seed.zip`
- 调用 `seedImportKnowledgeMap()`
- 断言基础落库成功

## Assertion Strategy

首批 happy path 至少断言 4 组结果：

1. **教材落库**
   - `textbooks` 中新增 1 条记录

2. **知识点落库**
   - `knowledge_points` 中新增父子两层节点
   - 核心字段正确，如 `node_id`、`title`、`parent_node_id`

3. **导入批次**
   - `import_batches` 中生成 `type = 'knowledge_map'` 的批次

4. **导入批次明细**
   - `import_batch_items` 记录教材与知识点导入对象

失败路径则重点断言：

- 抛错而不是静默失败
- 错误信息能指向缺失文件或 JSON 结构错误

## Risks

- `knowledgeMapService` 同时处理 zip 解压、JSON 解析、教材 upsert、知识点 upsert、批次记录，happy path 断言过少会漏风险，断言过多又会让测试脆。
- 种子导入依赖 resources 路径；若 mock 路径方式选错，可能把 smoke 测试写成环境依赖测试。
- 如果测试直接耦合太多查询实现细节，后续知识点字段调整会带来高维护成本。

## Acceptance Criteria

- 新增 `knowledgeMapService` 导入测试文件，纳入 `npm test`。
- 手动导入覆盖：
  - happy path
  - 缺文件错误
  - `knowledge_points.json` 结构错误
- 种子导入至少有 1 条 smoke 测试。
- 测试动态生成 zip，不提交二进制 fixture。
- 断言同时覆盖：
  - `textbooks`
  - `knowledge_points`
  - `import_batches`
  - `import_batch_items`
- 不扩大到查询接口、PDF 行为、重匹配、renderer 或 E2E。

## Task Breakdown

1. 盘点 `knowledgeMapService` 的手动导入和种子导入入口。
2. 设计最小 `textbooks.json` / `knowledge_points.json` fixture。
3. 在测试中动态生成 zip。
4. 为手动导入实现 happy path 与关键错误路径断言。
5. 为种子导入实现最小 smoke 断言。
6. 跑 `npm test` / `npm run typecheck` / `npm run build` 验证无回归。

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- 额外检查新增测试是否仍然只覆盖导入边界，没有混入查询、PDF 或 UI 逻辑
