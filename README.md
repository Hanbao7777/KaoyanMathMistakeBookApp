# 考研高数错题本 App

本项目是一个本地优先的考研数学错题整理与间隔复习桌面 App。它不内置 OCR，也不上传数据。用户可以通过配套 GPT 提示词将教材知识点和手写错题整理为标准导入包，再在 App 中完成知识地图管理、错题复习、复习计划、统计诊断和本地备份。

当前 `package.json` 版本：`0.1.0`（开发阶段，功能以 README 和源码为准）。

## 核心理念

- 本地优先：错题、图片、数据库、备份都保存在用户电脑本地。
- 不上传个人错题：App 不接入云数据库，也不主动上传任何文件。
- 不内置 OCR / AI：识别与整理由用户在外部 GPT 工具中完成。
- GPT 负责生成导入包，App 负责长期管理和复习。
- 教材知识点、教材页码、错题和复习计划联动。

## 功能特点

### 错题管理
- 添加/编辑错题：记录题目内容、错误思考、正确解析、答案，支持分类、题型、错因、难度、掌握程度等维度。
- 错题库：多维度筛选（学科/章节/题型/错因/掌握度/难度/来源），搜索，标签，排序。
- 错题详情：原图画廊（缩略图、缩放预览、拖拽）、公式渲染（KaTeX）、复习记录、知识点关联。
- 结构化导入：支持错题包 `wrong_questions_import.zip`（Excel + 图片），含预览、校验、批量图片复制。
- PDF 错题集导出 Beta：支持完整版（含解析）和练习版（只含题目）。

### 复习系统
- 4 种复习模式：今日待复习、薄弱错题、随机复习、按知识点复习。
- 间隔重复：根据复习结果自动计算下次复习时间，更新掌握程度。
- 复习 Session：连续刷题、实时反馈、本轮统计总结。

### 知识地图
- 教材知识点树形目录 + React Flow 图谱视图。
- 知识点详情：常见题型、错因、相关错题、平均掌握度。
- 教材 PDF 联动：绑定本地 PDF、显示/复制页码、手动跳页提示。
- 自动匹配：重新匹配已有错题与知识点的关联。

### 外部题库训练
- 题库导入：支持 `question_bank_import.zip`（Excel + 元数据 + 资源文件）。
- 刷题模式：随机、按年份、按分类、未练习题、错题重练。
- 练习记录：记录做对/做错/没思路，支持一键加入错题本。
- 原卷与解析 PDF 打开。

### 备考监督系统
- 备考监督中心：各科目总览、强度监督、拖延和进度风险预警。
- 每日计划：任务 CRUD、完成任务补记时长、跳过（需填写原因）、自动延期。
- 资料进度：自定义单位（页/题/章）、进度条、目标日期倒推落后提醒。
- 专注计时：绑定任务/科目计时，结束后写入学习记录，支持任务结算。
- 每日复盘：记录学习状态、完成情况、主要问题、明日优先事项。

### 统计与诊断
- Dashboard 首页：学习总览、待复习/薄弱/未掌握数量、高频错因、薄弱知识点 Top 5、备考监督概览。
- 诊断中心：章节分布、题型分布、错因分布、掌握程度分析、复习表现趋势、重点关注错题。

### 数据管理
- 数据库备份与恢复：每日自动备份、手动备份、恢复前/删除导入前保护备份。
- 导入批次管理：按导入批次查看详情、回滚数据（删除批次 + 关联题目 + 资源文件）。
- 完整 JSON 导入/导出，支持更改数据保存位置及迁移已有数据。

## 推荐工作流

1. 使用 `prompts/考研数学教材识别专家.md` 整理教材知识点，生成 `knowledge_map_import.zip`。
2. 在 App 中导入知识地图包。
3. 将教材 PDF 放入 `D:\KaoyanMathMistakeBook\textbooks`，或在知识地图中手动绑定 PDF。
4. 使用 `prompts/考研高数错题整理专家_V2.md` 整理错题图片，生成 `wrong_questions_import.zip`。
5. 在 App 中导入错题包。
6. 使用“重新匹配已有错题知识点”建立旧错题与知识点的关联。
7. 从 Dashboard 或复习中心开始复习。

## 安装与运行

项目技术栈：Electron + React + TypeScript + Vite + SQLite(sql.js)。

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run pack:win
```

`npm run pack:win` 会生成 Windows portable exe，默认输出到：

```text
release/
```

## 默认数据目录

App 默认使用：

```text
D:\KaoyanMathMistakeBook
```

目录结构：

```text
D:\KaoyanMathMistakeBook\data
D:\KaoyanMathMistakeBook\images
D:\KaoyanMathMistakeBook\textbooks
D:\KaoyanMathMistakeBook\exports
D:\KaoyanMathMistakeBook\backups
D:\KaoyanMathMistakeBook\temp
```

关键路径：

- SQLite 数据库：`D:\KaoyanMathMistakeBook\data\mistakes.db`
- 错题原图：`D:\KaoyanMathMistakeBook\images`
- 教材 PDF：`D:\KaoyanMathMistakeBook\textbooks`
- 导出文件：`D:\KaoyanMathMistakeBook\exports`
- 数据库备份：`D:\KaoyanMathMistakeBook\backups`

## 导入包格式

### 错题包

```text
wrong_questions_import.zip
├── import.xlsx
└── images/
    ├── 001.png
    └── 002.png
```

`import.xlsx` 字段：

```text
title, content, wrong_thinking, correct_solution, answer, category, question_type, error_reason, difficulty, mastery_level, source, tags, knowledge_points, image_path
```

### 知识地图包

```text
knowledge_map_import.zip
├── textbooks.json
└── knowledge_points.json
```

`book_page` 表示书本印刷页码，`pdf_page` 表示 PDF 实际页码。外部 PDF 阅读器不一定支持自动跳页，因此 App 会显示页码提示并提供复制 PDF 页码功能。

## GPT 提示词

`prompts/` 目录提供两类提示词：

- `考研数学教材识别专家.md`：生成 `knowledge_map_import.zip`。
- `考研高数错题整理专家_V2.md`：生成 `wrong_questions_import.zip`。

App 本身不内置 OCR 或 AI 服务。用户需要自行在外部 GPT 工具中使用提示词，并避免上传敏感个人信息。

## 隐私与数据安全

- App 本地优先，默认数据目录为 `D:\KaoyanMathMistakeBook`。
- App 不上传错题图片、教材 PDF 或数据库。
- App 不提供教材 PDF，用户需自行准备并确保拥有合法使用权。
- GPT 提示词需用户自行在外部 AI 工具中使用。
- 恢复备份会覆盖当前数据库，恢复前会自动创建 `before_restore` 保护备份。

## 已知问题

详见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

重点限制：

- PDF 错题集导出目前为 Beta，复杂公式和长图分页可能仍需人工检查。
- 外部 PDF 阅读器不一定支持 `file:///xxx.pdf#page=xx` 自动跳页。
- 图谱视图在大量知识点场景下仍可能需要性能优化。

## Roadmap

详见 [ROADMAP.md](ROADMAP.md)。

## 开发说明

- 主进程代码：`src/main`
- 渲染进程代码：`src/renderer`
- 共享类型：`src/shared`
- 本地路径管理：`src/main/services/pathService.ts`
- SQLite 数据与服务：`src/main/services`

开源仓库不应提交：

- `node_modules/`
- `dist/`
- `release/`
- `*.db`
- `data/ images/ textbooks/ exports/ backups/ temp/`
- 真实错题图片、真实教材 PDF、真实备份文件

## License

MIT License. See [LICENSE](LICENSE).
