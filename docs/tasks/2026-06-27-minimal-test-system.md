# 最小测试体系 — 实施任务

## Background

项目当前无正式测试框架。`package.json` 已新增 `npm test` 和 `npm run test:main` 入口，使用 Node.js 内置 `node:test` + `node:assert/strict`，通过 `require.cache` stub Electron 的 `app`/`dialog` API，在构建后的 `dist/main/` 上直接运行 CommonJS 测试。第一批 TickTick service 边界测试（`9cea968`）已落地并验证通过。

## Goal

在现有 `node:test` 基础设施上，继续补全第二批、第三批测试，优先覆盖数据安全链路（schema、备份恢复、导入解析），最终形成可随 CI 运行的最小回归套件。

## Non-Goals

- 不引入 Vitest/Jest/Mocha 等新测试框架（当前 `node:test` 足够，切换成本 > 收益）。
- 不做 renderer 组件 UI 测试（需 jsdom + React Testing Library，属 P2）。
- 不做性能基准测试（当前数据量未达到瓶颈）。
- 不做 Electron 窗口/IPC 端到端自动化（需 Spectron/Playwright，成本过高）。

## Scope

### 在 scope 内
- main process service 层集成测试（基于 sql.js 内存/文件数据库）。
- 纯函数单元测试（日期计算、NLP 解析、复习算法）。
- IPC 契约静态扫描（自定义脚本，不启动 Electron）。
- 小型 fixture（畸形 zip、最小 Excel、最小 JSON）用于导入解析测试。

### 在 scope 外
- renderer 页面组件渲染测试。
- 打包后 exe 的 GUI 自动化测试。
- 跨平台兼容性测试（当前以 Windows 为主）。

## Constraints

- 测试文件使用 `.test.cjs`，与现有 `ticktickService.test.cjs` 保持一致。
- 每个测试文件必须 `build:main` 后可在 `node:test` 中运行。
- 必须使用 `beforeEach` 重置数据库连接，`after` 清理临时目录。
- 临时目录使用 `fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-...'))`。
- Electron stub 模式沿用现有 `require.cache` 注入方案。
- 不改业务源码；若发现测试需要源码改动才能测，则记录为 bug 另派修复任务。

## Proposed Approach

1. **Batch 1（已完成）**：TickTick service 边界验证 — 空/无效 `list_id` 拒绝、空标题拒绝、正常创建/更新字段校验。
2. **Batch 2（已完成）**：Schema 初始化 + 备份恢复 smoke。
3. **Batch 3（随后）**：导入解析鲁棒性 + 复习算法纯函数。
4. **Batch 4（可选）**：IPC 契约扫描 + 其他 service 层（question bank、bridge sync、study supervisor）。

## Task Breakdown

### ✅ Batch 1 — TickTick Service 边界（已完成，`9cea968`）

文件：`tests/main/ticktickService.test.cjs`

| # | 用例 | 状态 |
|---|------|------|
| 1.1 | `createTickTickTask` 拒绝空 `list_id`（抛错：请先创建或选择一个清单） | ✅ 通过 |
| 1.2 | `createTickTickTask` 拒绝不存在的 `list_id`（抛错：清单不存在） | ✅ 通过 |
| 1.3 | `updateTickTickTask` 拒绝空/仅空白字符 `title`（抛错：任务标题不能为空） | ✅ 通过 |
| 1.4 | `updateTickTickTask` 拒绝不存在的 `list_id`（抛错：清单不存在） | ✅ 通过 |
| 1.5 | `createTickTickTask` 正常创建，字段完整（title 去空格、note、due_date、priority、tags 解析为数组） | ✅ 通过 |
| 1.6 | `updateTickTickTask` 正常更新全部可写字段，title 去空格、list_id 可切换、tags 替换 | ✅ 通过 |

验收：`npm run test:main` 6/6 通过。

---

### ✅ Batch 2 — Schema 初始化 + 备份恢复 smoke（已完成）

#### Task 2.1: Schema 初始化测试

文件：`tests/main/schema.test.cjs`

| # | 用例 | 说明 |
|---|------|------|
| 2.1 | 空数据库执行 `initializeDatabase()` 后关键表存在 | ✅ 已覆盖：questions、review_logs、knowledge_points、ticktick_lists、ticktick_tasks、ticktick_bridge |
| 2.2 | TickTick 关键列存在 | ✅ 已覆盖：list_id、title、priority、tags、created_at、updated_at |
| 2.3 | TickTick 关键索引存在 | ✅ 已覆盖：idx_ticktick_tasks_list、idx_ticktick_bridge_task |

验收：`npm test` 中 3/3 通过。

#### Task 2.2: 备份恢复 smoke 测试

文件：`tests/main/backupService.test.cjs`

| # | 用例 | 说明 |
|---|------|------|
| 2.4 | 有数据的数据库生成备份，备份文件有效且可重新 open | ✅ 已覆盖：文件存在、大小 > 0、sql.js 可读、任务数据可查询 |
| 2.5 | 恢复前自动生成 `before_restore` 保护备份 | ✅ 已覆盖：`beforeRestoreBackup` 文件存在 |
| 2.6 | 恢复后数据库数据与备份一致 | ✅ 已覆盖：恢复后只保留备份时任务 |

验收：`npm test` 中 2/2 通过。

辅助设施：`tests/main/helpers/mainTestEnv.cjs` 已抽取 main service 测试环境，统一 stub Electron、强制 `pathService.setDataRoot(testRoot/data-root)`、重置数据库连接并清理临时目录。

---

### ✅ Batch 3a — 复习算法 service 回归测试（已完成）

文件：`tests/main/reviewAlgorithm.test.cjs`

复习算法内嵌于 `databaseService.ts` 的 `submitReviewResult`，未提取为独立纯函数。因此采用 service 级黑盒回归测试，通过 `createQuestion` + `submitReviewResult` + `getQuestion` 验证间隔与掌握度转换。

| # | 用例 | 说明 | 状态 |
|---|------|------|------|
| 3.1 | 首次 correct → next_review_at +2 天，mastery 升一级 | consecutive_correct=1，interval=2 | ✅ |
| 3.2 | wrong → next_review_at +1 天，mastery 降一级，consecutive_correct 归零 | | ✅ |
| 3.3 | no_idea → next_review_at +1 天，mastery 降级，consecutive_correct 归零 | | ✅ |
| 3.4 | 连续 3 次 correct → 间隔递增 2/4/7 天 | mastery 从 '较弱' 升到 '已掌握' | ✅ |
| 3.5 | wrong 后再 correct → consecutive_correct 重置后从 1 重新开始，间隔回到 2 天 | | ✅ |

验收：`npm test` 5/5 通过。

#### Task 3.2: 结构化导入解析测试（已完成）

文件：`tests/main/import.test.cjs`

| # | 用例 | 说明 | 状态 |
|---|------|------|------|
| 3.6 | 畸形 zip（缺 `import.xlsx`）→ 抛错，不崩溃 | `prepareZipImport` 拒绝 | ✅ |
| 3.7 | Excel 中含不存在图片路径的行 → preview 标记 invalid，错误信息可观察 | `prepareExcelImport` | ✅ |
| 3.8 | 畸形 JSON → 抛错，不崩溃 | `prepareJsonImport` | ✅ |
| 3.9 | 正常 JSON → preview 全部 valid，`confirmStructuredImport` 创建错题 | happy path | ✅ |
| 3.10 | 正常 zip（含 `import.xlsx`）→ 解压、preview、confirm 创建错题 | happy path | ✅ |

辅助改动：`tests/main/helpers/mainTestEnv.cjs` 新增 `dialog.showOpenDialog` stub，测试中动态覆盖返回路径。fixture 在测试中动态生成（`xlsx`/`adm-zip` 为现有依赖），不提交二进制样本。

范围说明：本批次覆盖的是 `structuredImportService.ts` 的结构化错题导入解析。`knowledgeMapService.ts` 的知识地图导入属于独立服务边界，未纳入本批次，后续如需补测试应单独立项。

验收：`npm test` 5/5 通过。

---

### ✅ Batch 4a — IPC 契约静态扫描（已完成）

文件：`tests/ipc/ipc-contract-check.test.cjs`

| # | 检查项 | 说明 | 状态 |
|---|--------|------|------|
| 4.1 | `AppApi` 中每个方法在 `preload.ts` 中有对应实现 | 正则扫描 `api.ts` 方法名 vs `preload.ts` | ✅ |
| 4.2 | `preload.ts` 中每个 `invoke`/`send` 在 `registerIpc.ts` 或 `main.ts` 中有对应 handler | 正则扫描 channel 名，扫描两个文件 | ✅ |
| 4.3 | 契约扫描能检测到故意制造的假 channel 不匹配 | 自检测试 | ✅ |

发现的真实问题：`window:saveState`/`window:loadState` channel 在 `preload.ts` 中使用，但不在 `registerIpc.ts` 中注册，而是在 `main.ts` 中注册。扫描已扩展为同时扫描 `registerIpc.ts` 和 `main.ts`。

验收：`npm test` 3/3 通过。

#### Task 4.2: Question Bank Service

文件建议：`tests/main/questionBank.test.cjs`

| # | 用例 | 说明 |
|---|------|------|
| 4.4 | 题库导入后外部题目数据完整 | |
| 4.5 | 作答记录关联正确（external_question_attempts） | |
| 4.6 | 重复导入同一批次去重/跳过 | |

#### ✅ Batch 4b — Bridge Sync Service（已完成）

文件：`tests/main/bridgeService.test.cjs`

| # | 用例 | 说明 | 状态 |
|---|------|------|------|
| 4.4 | TickTick task + `sync_review=1` bridge → `syncTaskCompletedToReview` 写入 `review_logs` | 校验 review log、question review_count/correct_count/consecutive_correct | ✅ |
| 4.5 | 同一天同一 TickTick 任务重复同步 → 不重复写入 `review_logs` | 校验 duplicate guard | ✅ |

验收：`npm run build:main && node --test tests/main/bridgeService.test.cjs` 2/2 通过。

---

## Acceptance Criteria

- [x] Batch 2 全部用例 `npm test` 通过。
- [x] Batch 3 全部用例 `npm test` 通过。
- [x] 新增测试不破坏 `npm run typecheck` 和 `npm run build`。
- [ ] `npm run test:main` 运行时间 < 10 秒（单线程 sql.js 足够快）。
- [ ] 每个测试文件独立，不依赖其他测试文件的执行顺序或残留状态。

## Risks

1. **sql.js WASM 路径**：`databaseService.ts` 中 `locateFile` 可能需要根据测试环境调整 WASM 路径。
2. **Electron 依赖泄漏**：新增的 service 文件可能直接 `import { app } from 'electron'`，测试中需补充 stub。
3. **时间敏感测试**：`review-algorithm.test.cjs` 中涉及 `new Date()` 的计算，需固定测试日期（`process.env.TZ` 或 mock Date）。
4. **Fixture 管理**：zip 文件不应提交仓库，建议在 `tests/fixtures/` 下放生成脚本，在 `before` 中动态创建。

## Verification

- 运行 `npm run test:main` 确认 Batch 1 仍通过。
- 每完成一个 Batch 的子任务，本地运行对应测试文件确认通过后再标记完成。
- 最终由 Codex 审核全部用例是否覆盖数据安全核心链路。
