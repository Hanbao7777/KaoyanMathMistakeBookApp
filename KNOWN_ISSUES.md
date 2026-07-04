# Known Issues

## 构建与运行环境

### `npm run build` 可能失败：缺少 Rollup optional dependency

- 现象：`npm run build` 报错缺少 `@rollup/rollup-linux-x64-gnu` 等可选依赖。
- 原因：Vite / Rollup 的平台 native optional dependency 在本地 `node_modules` 中缺失，通常是 npm optional dependency 安装问题。
- workaround：按现有 lockfile 重新执行 `npm install`，必要时删除 `node_modules` 后重装。
- 状态：当前环境已通过 `npm install` 修复，并已验证 `npm run typecheck` 与 `npm run build` 通过；保留此条作为新环境排查说明。

### Electron exe 双击无反应（`ELECTRON_RUN_AS_NODE` 环境变量）

- 现象：双击 `release/win-unpacked/考研高数错题本.exe` 或 portable exe 后没有窗口，或进程一闪而过。
- 原因：系统或 shell 进程继承了 `ELECTRON_RUN_AS_NODE=0/1`，导致 Electron 以 Node 模式启动而非 GUI 模式。
- workaround：启动前在 PowerShell 中执行 `$env:ELECTRON_RUN_AS_NODE = $null`，并检查系统环境变量中是否残留该变量。
- 状态：非业务代码 bug，但影响打包版启动体验；需在文档和启动脚本中显式清理。

---

## TickTick 任务管理（Beta）

TickTick 模块已大量实现，但主流程仍有 P0/P1 问题待修复。详细清单见 [TICKTICK_KNOWN_BUGS.md](TICKTICK_KNOWN_BUGS.md)。

### P0：布局与启动

- **主内容区宽度被挤成约 12px**（代码已修，待人工/打包版验收）：根容器已从旧 `.app-shell` grid 隔离为独立的 `.ticktick-root` + `TickTickShell`，`ticktick.css` 已补齐宽高/overflow 规则；仍需在打包版逐页确认主内容区正常占满。
- **侧边栏工具区被推到文档底部**（代码已修，待人工/打包版验收）：已移除 inline `marginTop:auto`，改为 `.tt-sidebar-scroll` 中间滚动 + `.tt-sidebar-tools` 固定工具区；仍需人工确认专注计时/设置常驻可见且可切换。
- **exe 启动环境**（workaround / 文档收口）：非业务代码 bug，启动前需清理 `ELECTRON_RUN_AS_NODE`，详见构建环境节。

### P1：数据完整性

- **任务详情面板不能真正编辑保存**（代码已修，待人工/端到端验收）：已改为受控表单并调用 `updateTickTickTask`；仍需人工确认改动持久化与跨清单移动。
- **Quick Add 在无清单时创建孤儿任务**（代码已修，待人工/端到端验收）：前端在无清单时禁用 Quick Add / AI 创建并提示先建清单，后端校验 `list_id` 非空且存在；仍需人工确认清空清单后无法写入空 `list_id`。
- **完成关联复习任务时未真正同步**（已修复）：完成/取消完成已收口到 main 侧 `completeTaskWithReviewSync` / `uncompleteTaskWithReviewSync` 统一入口，所有 renderer 入口一致触发 review sync / undo sync。
- **专注计时器状态竞态**（已修复）：计时器状态已收口到 main 侧 `FocusTimerEngine` 单一真源，FocusTimerPage 和 DesktopWidget 均为只读客户端 + 命令入口，不再各自独立推进时间。

### P2：体验与维护

- ~~**前后端默认设置不一致**~~（已修复）：前后端 `autoCreateReviewTasks` 默认值现已统一为 `true`。
- ~~**收集箱复用 TodayPage**~~（已修复）：已实现独立 `InboxPage`（过滤 `!due_date && !parent_id`），`inbox` 路由不再渲染 TodayPage；待人工确认过滤行为。
- ~~**TickTickShell 组件重复/未使用**~~（已修复）：`App.tsx` 已统一使用 `TickTickShell`，不再手写重复 shell。
- **大量错误被静默吞掉**：Today、Sidebar、Settings 等页面大量 `catch {}`，API 报错时用户只见空白。

### Phase 2 占位功能

- 看板视图（KanbanPage）、艾森豪威尔矩阵（EisenhowerPage）、习惯打卡（HabitsPage）为占位/空壳实现。
- 日历的周视图和日视图是占位符。
- 白噪音 UI 可选，但 Web Audio 生成未完整连接。

---

## 错题本核心功能

### v1.0.0-beta.1（持续有效）

- PDF 错题集导出目前为 Beta，复杂公式、长图分页可能存在排版问题。
- 外部 PDF 阅读器不一定支持 `file:///xxx.pdf#page=xx` 自动跳页。
- 当前采用"打开 PDF + 显示 PDF 页码 + 复制页码 + 手动跳页"的稳定方案。
- 移动端布局已尽量适配，但主要体验仍以桌面端为主。
- 本项目不包含任何教材 PDF，用户需自行准备合法教材文件。
- 大量知识点或大量错题时，图谱视图性能仍可能需要后续优化。
- 恢复备份后建议重启 App，而不是依赖所有页面状态自动刷新。

---

## AI / OCR（Beta）

- OCR 依赖本地 Python 3.9+ 和 `paddlepaddle/paddleocr`，环境未就绪时 AI 导入不可用。
- DeepSeek AI 结构化输出偶尔可能不符合预期 JSON 格式，需人工校对。
- AI 错因诊断需要配置有效 DeepSeek API Key 且需联网调用 DeepSeek 服务。

---

## 开发/仓库治理

### 行尾符（CRLF / LF）噪声

- 当前工作区中约 23 个文件存在纯 CRLF ↔ LF 转换 diff（零逻辑变化），导致 `git diff` 显示约 18,000 行改动，掩盖真实逻辑变更。
- 计划：新增 `.gitattributes` 并独立 commit 标准化，不混入功能 commit。
- 状态：待执行。

### 测试体系（最小回归套件已落地，最小 CI 已接入）

- 已有 `npm test` / `npm run test:main` 入口，基于 Node.js 内置 `node:test`，构建后在 `dist/main/` 上运行 `.test.cjs`。
- 已覆盖的高风险链路（约 41 个用例）：schema 初始化、备份/恢复、结构化导入解析、导入批次删除、复习算法、TickTick 任务创建/更新边界、TickTick 桥接同步、外部题库作答、IPC 契约静态扫描、migration 升级、知识地图导入、study supervisor 监督闭环。
- 剩余缺口：未覆盖 renderer 组件与 Electron 端到端（其余高风险链路含 migration 升级、知识地图导入、study supervisor 监督闭环已纳入回归）。
- 详见任务台账 [docs/tasks/2026-06-27-minimal-test-system.md](docs/tasks/2026-06-27-minimal-test-system.md)。
- 状态：最小回归套件已落地，最小 CI 已接入（GitHub Actions 运行 test/typecheck/build），仍需继续扩展覆盖面。
