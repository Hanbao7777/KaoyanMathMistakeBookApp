# 考研高数错题本 App

本项目是一个本地优先的考研数学错题整理与间隔复习桌面 App。它不内置 OCR，也不上传数据。用户可以通过配套 GPT 提示词将教材知识点和手写错题整理为标准导入包，再在 App 中完成知识地图管理、错题复习、复习计划、统计诊断和本地备份。

当前发布整理版本：**V1.0 Beta / v1.0.0-beta.1**  
当前 `package.json` 版本仍为 `0.1.0`，源码功能以本文档为准。

## 核心理念

- 本地优先：错题、图片、数据库、备份都保存在用户电脑本地。
- 不上传个人错题：App 不接入云数据库，也不主动上传任何文件。
- 不内置 OCR / AI：识别与整理由用户在外部 GPT 工具中完成。
- GPT 负责生成导入包，App 负责长期管理和复习。
- 教材知识点、教材页码、错题和复习计划联动。

## 功能特点

- 错题包导入：支持 `wrong_questions_import.zip`。
- 教材知识地图导入：支持 `knowledge_map_import.zip`。
- 错题库与错题详情：搜索、筛选、分类、图片显示、公式渲染。
- 复习系统 V2 / V2.1：今日复习、薄弱复习、随机复习、按知识点复习。
- 知识地图 / 图谱视图：教材知识点树、React Flow 图谱、相关错题跳转。
- 教材 PDF：绑定本地 PDF、显示 PDF 页码、复制页码、手动跳页提示。
- Dashboard：学习总览、今日建议、薄弱知识点、高频错因。
- 学习统计 / 诊断中心：章节、题型、错因、掌握程度、复习表现。
- 数据备份与恢复：每日自动备份、手动备份、恢复前保护备份。
- PDF 错题集导出 Beta：支持完整版和练习版。

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
