# Roadmap

> 图例：🎨 = 实现时使用 `frontend-design` skill 保证视觉质量；✅ = 已大量实现；🔧 = 正在收口/稳定化；⏳ = 尚未开始

---

## 当前状态与后续重点

**个人日用稳定版已经完成。** portable 核心链路、备份恢复、复习提交与持久化撤销、MCP 导入、打包校验、Windows CI 和最终人工使用均已通过；证据见[个人稳定版执行记录](docs/archive/completed/tasks/2026-07-26-mistake-book-personal-stable-execution-record.md)。该目标不要求所有 Beta 页面、未来功能和历史技术债同时完成。

1. **错题本本体按需维护** — 当前没有阻断个人日用的已知问题；后续以真实使用反馈驱动修复，不为扩展功能重新打开已完成的稳定版门禁。
2. **测试覆盖继续增强（非阻断）** — 已有 main/service 回归、Electron 启动与 Agent Control Plane E2E、portable 隔离验收；未来可继续补错题本 renderer 业务流的自动化覆盖。
3. **TickTick Beta 可选收口（非当前主线）** — 按 [TICKTICK_KNOWN_BUGS.md](TICKTICK_KNOWN_BUGS.md) 完成剩余人工验收、占位功能和低频错误提示，不影响错题本个人稳定版结论。
4. **文档与仓库治理** — 保持 README / ROADMAP / KNOWN_ISSUES 与真实状态一致；完成记录进入 `docs/archive/`，构建产物和本地备份不进入产品源码提交。
5. **PDF 教材联动及其他增强** — 保持后续优先级（见 V1.4 / V2.0），当前不推进。

---

## V1.0 Beta（已交付）

- 错题包导入
- 知识地图包导入 + 内置种子考点（56 个）
- 错题库与错题详情
- 间隔复习系统 V2 / V2.1
- 今日复习、薄弱复习、随机复习、按知识点复习
- Dashboard 学习总览
- 知识地图与图谱视图
- 教材 PDF 绑定、页码提示、复制页码、手动跳页
- 学习统计 / 诊断中心
- 数据备份与恢复
- PDF 错题集导出 Beta
- 全局 UI 风格统一

---

## V1.1 — 交互体验升级（✅ 已实现并归档）

目标：消除项目中所有的 `alert()` / `confirm()` 原生弹窗，建立统一的交互基础设施。

### 基础设施（✅ 已实现）

- 🎨 **Toast 通知组件** — 替代所有 `alert()`，右上角滑入自动消失，支持 success/warning/error 三种状态
- 🎨 **自定义 Modal 确认弹窗** — 替代所有 `confirm()`，支持标题、正文、操作按钮、危险操作红色高亮
- 🎨 **Skeleton 骨架屏** — 替代"加载中..."纯文字，与页面布局结构一致
- 🎨 **按钮 loading 状态** — 所有异步操作按钮内置 spinner，防止重复点击

### 体验速赢（✅ 已实现）

- **复习键盘快捷键** — 空格=显示答案，1=做对，2=做错，3=没思路，N=下一题
- **复习操作可撤销** — 提交结果后 5 秒内可撤销，恢复原来的掌握度和下次复习时间
- **窗口状态记忆** — 窗口大小、位置持久化到 localStorage
- 🎨 **全局搜索 Ctrl+K** — 弹窗搜索框，跨错题 + 知识点即时匹配，回车直接跳转

> 注：V1.1 功能已在代码中实现；其计划文档已归档至 `docs/archive/completed/plans/2026-05-25-v1.1-interaction-upgrade.md`。

---

## V1.2 — AI + OCR 智能导入（✅ Beta 保留，个人稳定版暂不推进）

目标：用户拍照或选图即可自动生成结构化错题，不再需要离开 App 手动整理。

### OCR 管道（✅ 已实现，Beta）

- **PaddleOCR (PP-OCRv4)** — 图片 → 原始文本提取，本地离线运行（需 Python 3.9+ 和 paddlepaddle/paddleocr）
- **DeepSeek 结构化引擎** — OCR 纯文本 → 结构化 JSON（题目 / 错误思考 / 解析 / 答案 / 分类 / 标签 / LaTeX 公式）
- 🎨 **拍照导入流程** — 拍照或选图 → OCR 预览 → AI 填充表单 → 人工校对 → 确认保存

### AI 诊断（✅ 已实现，Beta）

- **AI 错因深度诊断** — 读取题目 + 用户错误思考文本，分析真正的知识盲点，建议回顾的知识点，推荐同类练习方向

> 注：现有 AI/OCR 能力仍作为可选 Beta 功能保留并已记录；个人稳定版范围暂不继续其环境依赖、输出校验等稳定化/正式化工作。当前个人工作流通过 Codex/MCP 直接导入错题。相关计划已保留至 `docs/archive/deferred/plans/2026-05-25-v1.2-ai-ocr-import.md`，并非功能移除或完成声明。

---

## V1.3 — TickTick 收口与稳定化（🔧 可选 Beta 收口，非当前主线）

### TickTick P0 / P1 修复

- 主界面布局修复：TickTick 模式主内容区宽度被挤成 ~12px（CSS 根容器隔离）— 代码已修，待人工/打包版验收
- 侧边栏工具区定位：专注计时/设置不应被推到文档底部 — 代码已修，待人工/打包版验收
- 任务详情面板真正编辑保存：受控 state + `updateTickTickTask` API 调用 — 代码已修，待人工/端到端验收
- 孤儿任务防护：无清单时禁用 Quick Add，后端校验 `list_id` — 代码已修，待人工/端到端验收
- 同步链路打通（已修复）：完成/取消完成收口到 main 侧 `completeTaskWithReviewSync` / `uncompleteTaskWithReviewSync` 统一入口，所有 renderer 入口一致生效
- 专注计时器状态竞态（已修复）：收口到 main 侧 `FocusTimerEngine` 单一真源，消除双状态机/双 interval

### TickTick P2 / 体验

- 前后端默认设置值统一 — ✅ 已完成（代码层，`autoCreateReviewTasks` 前后端默认均为 `true`）
- 收集箱实现独立 InboxPage（不复用 TodayPage）— ✅ 已完成（代码层，待人工确认过滤行为）
- TickTickShell 与 App.tsx 的 shell 二选一，删除死代码 — ✅ 已完成（App 统一使用 `TickTickShell`）
- 页面级错误提示替代静默 `catch {}` — 🔧 初始化加载（主链路 5 页 + Eisenhower/Kanban/Habits）+ 操作路径（Calendar 周/日视图、Inbox toggle、Widget loadData/completeTask/addTask、FocusTimer 命令与设置加载）已补可见错误态/toast + 重试（待人工验收）；高频轮询 catch 故意保留静默；Kanban/Eisenhower toggle/delete 仍待补齐

### Desktop Widget 验证

- 窗口位置/尺寸记忆、resize、pin、主窗聚焦
- Quick Add 不创建孤儿任务

---

## V1.4 — 效率增强

### 批量操作

- 批量修改掌握程度
- 批量添加/移除标签
- 🎨 批量删除（带预览确认）

### 复习系统

- **间隔复习算法可配置化** — 暴露复习间隔参数：激进 / 标准 / 保守 三档可选
- 复习历史日历热力图

### 交互增强

- 🎨 **侧边栏可折叠** — 折叠后只显示图标，释放横向空间
- 🎨 **页面切换过渡动画** — fade / slide transition
- 🎨 **图片拖拽上传** — 添加/编辑错题时支持拖拽图片到表单区域
- **图片画廊键盘导航** — 左右箭头切换图片，ESC 关闭预览

### 代码健康

- **databaseService.ts 拆分** — 按领域拆为 questionService + reviewService + statsService + settingsService
- **registerIpc.ts 拆分** — 按领域拆 IPC registrar

### PDF 导出优化（原 V1.1）

- 复杂公式分页优化
- 长图裁切和排版改善

---

## V2.0 — 平台增强

- **PDF.js 内置教材阅读器** — 教材 PDF 在 App 内直接打开，精确页码跳转，不再依赖外部 PDF 阅读器（原 V1.2）
- **大页面拆分** — KnowledgeMapPage 和 QuestionBankPage 提取子组件
- 🎨 **深色模式** — CSS 变量驱动 light/dark 切换
- **虚拟滚动** — 大量数据列表性能优化
- 🎨 **右键上下文菜单** — 错题列表右键快捷操作

---

## V2.1 — 扩展

- 多教材管理
- 多科目扩展（专业课、政治、英语）
- 更多统计图表和导出模板
- 可选云同步或增强迁移能力

---

## Backlog（待排期）

- 考点汇总替换知识地图（设计已完成，实现未开始，属中高风险数据迁移，需在测试体系建立后推进）
- 错题列表多选（shift/ctrl 批量选中）
- 知识地图图谱性能优化（大量节点场景）
- 移动端适配增强
- 更细粒度复习计划模板
- 复习草稿纸（白板/手写区域）
