# GPT 提示词说明

本文件夹包含“考研数学错题本 App”的配套提示词。

## 1. 考研数学教材识别专家

用途：

```text
教材 PDF / 教材截图
→ 识别章节、知识点、book_page、pdf_page
→ 生成 knowledge_map_import.zip
```

生成文件：

```text
knowledge_map_import.zip
├── textbooks.json
└── knowledge_points.json
```

默认不包含 PDF 本体。请将教材 PDF 手动放入：

```text
D:\KaoyanMathMistakeBook\textbooks
```

并确保 `textbooks.json` 中的 `file_name` 与本地 PDF 文件名完全一致。

## 2. 考研高数错题整理专家 V2

用途：

```text
手写错题图片
→ 识别题目、错误思考、正确解析和答案
→ 分类、标错因、绑定 knowledge_points
→ 生成 wrong_questions_import.zip
```

生成文件：

```text
wrong_questions_import.zip
├── import.xlsx
└── images/
```

V2 保留用于需要 Excel/ZIP 中间包的旧版批量导入流程。

## 3. 考研数学错题导入助手 V3

用途：

```text
手写错题图片
→ 识别并生成结构化预览
→ 查询重复题和现有知识点
→ 用户确认
→ 通过 MCP 直接创建错题并绑定知识点
→ 回读核验
```

V3 不生成 ZIP，适合在 Codex 中直接把图片导入正在运行的 App。

## 4. 考点数据生成专家

用途：

```text
考点汇总.txt
→ 解析章节、考点层级结构
→ 生成 knowledge_map_seed.zip
```

生成文件：

```text
knowledge_map_seed.zip
├── textbooks.json
└── knowledge_points.json
```

此文件打包进 App 的 `resources/` 目录，首次启动时自动导入。

## 推荐使用顺序

1. App 内置考点汇总数据，首次启动自动导入，无需手动操作。
2. 如需更新考点数据，使用”考点数据生成专家”重新生成 `knowledge_map_seed.zip`。
3. 日常录入优先使用“考研数学错题导入助手 V3”，确认预览后通过 MCP 直接导入。
4. 需要离线批量导入时，使用“考研高数错题整理专家 V2”生成 `wrong_questions_import.zip`，再在 App 中导入。
5. 导入后可在 Dashboard、错题库、知识地图、图谱视图和复习系统中联动使用。
