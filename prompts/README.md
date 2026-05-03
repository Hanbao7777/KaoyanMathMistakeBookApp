# GPT 提示词说明

本文件夹包含“考研高数错题本 App”的两个配套 GPT 提示词。

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

## 推荐使用顺序

1. 先使用“考研数学教材识别专家”处理教材，生成 `knowledge_map_import.zip`。
2. 在 App 中导入知识地图包。
3. 把教材 PDF 放入 `D:\KaoyanMathMistakeBook\textbooks`。
4. 再使用“考研高数错题整理专家 V2”处理错题图片，生成 `wrong_questions_import.zip`。
5. 在 App 中导入错题包。
6. 导入后可在 Dashboard、错题库、知识地图、图谱视图和复习系统中联动使用。
