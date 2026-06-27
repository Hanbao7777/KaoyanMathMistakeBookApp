# 项目现状评估与交付路线图

日期：2026-06-27

## 项目现状

当前仓库已从“错题本原型”扩展为本地优先 Electron 桌面应用，覆盖错题管理、复习、知识地图、题库训练、备考监督、AI/OCR、TickTick 风格任务系统和本地备份恢复。

- 技术栈：Electron + React + TypeScript + Vite + sql.js(SQLite WASM)。
- 数据流：Renderer `window.api` -> preload -> IPC -> main services -> 本地 SQLite / 文件目录。
- 产品形态：双模式架构。
  - 错题本模式：错题、复习、知识地图、题库、导入导出、统计诊断、备考监督。
  - TickTick 模式：任务、清单、日历、专注计时、AI 计划、复习桥接。
- 状态管理：以页面级 React state、`App.tsx` 顶层状态和少量 `localStorage` 为主，尚无统一全局状态层。
- 构建链路：`package.json` 已定义 `dev`、`typecheck`、`build`、`pack:win`；当前 `npm run build` 失败，原因是缺少 Rollup optional dependency `@rollup/rollup-linux-x64-gnu`。

核心判断：项目最大问题不是功能太少，而是功能面已很宽，但交付稳定性、测试体系、文档一致性、模块边界没有同步跟上。

## 已完成

以下仅基于当前仓库内容判断。

- 错题本主链路：错题 CRUD、列表、详情、图片、公式、筛选、搜索、标签、掌握程度、错因字段。
- 复习与统计：今日复习、薄弱复习、随机复习、按知识点复习、复习记录、结果提交、Dashboard / Stats。
- 知识地图与题库：知识地图 ZIP 导入、树形结构、图谱视图、教材 PDF 绑定、错题知识点关联、重匹配、外部题库导入和训练。
- 导入导出与数据管理：错题包、JSON、Excel、ZIP 结构化导入，PDF 导出 Beta，备份恢复，导入批次管理。
- 备考监督与 TickTick：备考监督中心、每日计划、资料进度、学习记录、专注计时、TickTick 风格任务/日历/清单/看板/四象限/习惯/widget 等模块。
- AI / OCR：OCR 脚本与调用入口、DeepSeek 配置和连接测试、结构化错题、AI 错因诊断、TickTick AI 任务拆解/日计划/复盘。

## 未完成

### 交付链路未闭环

- `npm run typecheck` 可作为基础校验。
- `npm run build` 当前失败，失败点是依赖安装/平台 optional dependency 缺失。
- 在修复前，不能认定当前仓库稳定可打包交付。

### 测试体系缺位

- `package.json` 没有正式 `test` 脚本。
- 当前可见测试文件不足以覆盖核心风险链路。
- 高风险但缺少自动化验证的方向：数据库迁移、导入解析、备份恢复、批次删除、复习算法、知识点重匹配、TickTick 桥接同步、AI/OCR 输出校验。

### 文档与实现不一致

- README 仍描述“不内置 OCR / AI”，但源码已有 OCR、DeepSeek、AI 导入、AI 诊断、TickTick AI。
- TickTick 有独立功能和问题文档，但主 README / ROADMAP / Known Issues 尚未统一表达其正式状态。
- 设计文档、计划文档、阶段报告、排查报告分散在 `docs/`、`docs/superpowers/`、`tishici/`、根目录文档中，入口不清晰。

### TickTick 未完全收口

从 `TICKTICK_KNOWN_BUGS.md` 看，仍存在 P0/P1/P2 和 Phase 2 未收口问题：

- P0：主界面布局、侧边栏、exe 启动环境。
- P1：任务详情编辑保存、孤儿任务、同步 IPC、计时器状态竞态。
- P2/Phase 2：默认值不一致、看板/四象限/习惯/widget 等能力需要补齐验证与产品定位。

### 考点汇总替换知识地图尚未实现

- `docs/superpowers/specs/2026-06-02-考点汇总替换知识地图-design.md` 已有设计。
- `docs/superpowers/plans/2026-06-02-考点汇总替换知识地图.md` 已有实施计划。
- 按当前材料判断，实现尚未开始或未完成收口。
- 该任务涉及知识点数据源、启动导入、已有错题重匹配、AI prompt 与分类列表，属于中高风险数据迁移任务，不应在缺测试时贸然推进。

### 工作区改动未收敛

- 当前工作区存在大量已修改和未跟踪文件。
- Claude 结论提到 18k+ 未提交 diff。
- 后续新增功能前，应先明确这些改动的来源、目的、完成度和是否可丢弃，避免半成品混入正式路线。

## 可优化项

### 架构与模块边界

优先治理以下重职责文件：

- `src/main/services/databaseService.ts`：拆为 question / review / stats / settings / data-portability / migration 等服务。
- `src/main/ipc/registerIpc.ts`：按领域拆分 IPC registrar，避免所有通道集中在单文件。
- `src/renderer/App.tsx`：拆出 mode router、mistake shell、ticktick shell、timer provider、navigation state。
- `KnowledgeMapPage.tsx`、`QuestionBankPage.tsx`：提取组件和 hooks。

### SQL 与数据访问

- 统一 SQL helper、事务边界、错误处理、JSON 字段解析、日期字段规范。
- 对高风险写操作统一建立“先备份 / 可回滚 / 可验证”的工程约束。

### 测试与验证

建议先建立最小测试金字塔：

1. 服务层单元测试：纯函数、日期计算、复习算法、字段转换。
2. 数据库集成测试：临时 sql.js 数据库 + schema + migration + CRUD。
3. 导入回归测试：小型 fixture zip/xlsx/json。
4. 备份恢复测试：恢复前保护备份、恢复后数据库可读。
5. IPC 契约测试：关键 API 入参/出参与错误信息。
6. 手工验收清单：打包 exe、导入、复习、备份恢复、TickTick 同步、AI/OCR 配置。

### 文档治理

- README：只保留真实已实现能力，并明确正式功能 / Beta / 实验功能。
- ROADMAP：把近期重点调整为“交付稳定化优先”。
- KNOWN_ISSUES：合并主产品、TickTick、PDF、OCR/AI、构建环境问题。
- docs：保留稳定用户文档与设计文档，历史报告归档。

## 风险

- 数据风险：sql.js 整库导出写盘模式对大数据量、异常退出、并发写入、恢复覆盖都需要额外验证；导入、批次删除、知识点替换、重匹配、备份恢复都可能影响用户长期数据。
- 交付风险：当前构建失败；release/dist/node_modules 等构建产物在仓库中出现，容易造成环境污染和误判。
- 产品边界风险：错题本、备考监督、TickTick、AI/OCR 同时推进，产品边界变宽，若不明确主线，容易形成“都有但都不够稳”。
- 维护风险：大文件继续增长会拖慢修改速度，增加回归概率；缺少测试时进行数据迁移和大重构风险较高。
- 文档风险：README 与实际能力不一致会影响用户预期、验收和交接；重复文档分散，容易出现说法冲突。

## 分阶段路线图

### 阶段 0：冻结范围与清点现场

先做：清点 18k+ 未提交 diff，按功能/修复/文档/实验改动分组；标记保留、回退、单独验收项；暂停新增大功能；明确 TickTick、AI/OCR、考点汇总替换知识地图是否进入当前交付范围。

验收：工作区改动来源清楚；当前交付范围明确；实验性能力不再混入正式能力描述。

### 阶段 1：交付稳定化

先做：修复 `npm run build`；校验 `npm run typecheck`、`npm run build`、`npm run pack:win`；更新 README；整合 Known Issues；建立最小手工验收清单。

后做：补开发环境说明与常见构建问题；明确 release/dist/node_modules 等产物的版本管理策略。

验收：类型检查通过；构建通过；主 README 与当前实现一致；用户能按文档启动和构建。

### 阶段 2：数据安全与最小测试体系

先做：添加正式 `test` 脚本和测试框架；为 schema/migration、导入、备份、恢复、批次删除、复习算法补最小测试。

后做：补知识点重匹配、题库导入、TickTick 桥接同步、AI/OCR 输出校验测试。

验收：高风险数据操作有自动化回归；备份/恢复/导入失败时有可读错误信息；后续重构有基本安全网。

### 阶段 3：TickTick 与监督系统收口

先做：按 `TICKTICK_KNOWN_BUGS.md` 处理 P0/P1；验证任务详情保存、孤儿任务防护、同步 IPC、专注计时器状态机；统一前后端默认设置；对 Today/List/Calendar/Focus/Settings 做手工验收。

后做：收口 Phase 2；明确 TickTick AI 正式/Beta 状态；把 TickTick 文档并入主文档体系。

验收：TickTick 主流程稳定；与错题复习、专注计时、学习统计的联动可复现；文档明确其状态。

### 阶段 4：架构拆分与代码治理

先做：拆分 `databaseService.ts`、`registerIpc.ts`、`App.tsx` 的顶层状态和模式路由。

后做：拆分 `KnowledgeMapPage.tsx`、`QuestionBankPage.tsx`；统一 SQL helper、事务、错误处理、日期处理；形成模块边界文档。

验收：大文件职责明显收敛；新增功能不再必须修改少数巨型文件；测试仍通过。

### 阶段 5：考点汇总替换知识地图

先做：复核既有 design/spec/plan 是否仍符合当前代码；准备 seed zip fixture 和迁移测试；验证旧知识点、旧错题、旧分类的兼容策略。

后做：实施启动导入、自动重匹配、分类更新、prompt 更新；补用户说明和回退方案；用真实样例数据验收。

验收：替换前自动备份；替换后错题关联可用；失败时可回滚或给出明确恢复路径。

### 阶段 6：AI/OCR 正式化

先做：明确 AI/OCR 是正式能力还是可选 Beta；补 OCR 环境检测、依赖说明、失败提示；补 DeepSeek 配置、连接测试、隐私说明、人工校对路径。

后做：增强 AI 输出 schema 校验；增加失败降级和重试策略；将 AI/OCR 纳入主验收清单。

验收：用户能从配置到导入完成闭环；失败时知道如何处理；文档不再与实现冲突。

## 重复文档整理建议

当前不建议立即删除文件，建议先建立文档索引和归档策略。

### 建议保留为主入口

- `README.md`：项目总览、安装运行、正式功能、Beta/实验功能。
- `ROADMAP.md`：公开路线图，只放高层阶段，不放具体执行细节。
- `KNOWN_ISSUES.md`：统一已知问题入口。
- `docs/使用说明.md`、`docs/备份与恢复说明.md`、`docs/导入错题包说明.md`、`docs/导入知识地图包说明.md`：用户文档。
- `docs/design/`：正式设计、评估、架构说明。
- `docs/superpowers/plans/`：仍准备执行的实施计划。
- `docs/superpowers/specs/`：仍有效的设计规格。

### 建议归档或合并

- `tishici/` 下阶段汇报、排查报告、临时审查报告：建议迁移到 `docs/archive/`，按日期和主题命名。
- `TICKTICK_FEATURES.md`：若 TickTick 进入正式交付，建议合并精简到 README + docs/design/TickTick 设计文档；原文件归档。
- `TICKTICK_KNOWN_BUGS.md`：建议吸收进统一 `KNOWN_ISSUES.md`，保留详细版本归档。
- 过时计划文档：如果已被新计划替代，移动到 `docs/archive/`，不要与活跃计划混放。

### 建议新增索引

后续可新增 `docs/README.md` 作为文档索引，列出用户文档、设计文档、实施计划、归档文档、已知问题入口。

## 先做什么、后做什么

1. 先清点未提交 diff，冻结范围。
2. 再修复 build，恢复可交付链路。
3. 再校准 README / ROADMAP / Known Issues，消除文档失真。
4. 再补最小测试体系，优先覆盖数据安全链路。
5. 再收口 TickTick P0/P1。
6. 再拆分大文件。
7. 最后推进考点汇总替换知识地图、AI/OCR 正式化和更多体验增强。

## 当前前 5 优先事项

1. 清点并收敛 18k+ 未提交 diff，确定当前可交付范围。
2. 修复 `npm run build` 缺失 Rollup optional dependency 的问题，恢复构建闭环。
3. 更新 README / ROADMAP / Known Issues，使 OCR、DeepSeek、TickTick AI 等描述与源码一致。
4. 建立最小测试体系，优先覆盖导入、备份恢复、迁移、批次删除、复习算法。
5. 按 P0/P1 收口 TickTick 主流程，再决定其正式/Beta 产品边界。
