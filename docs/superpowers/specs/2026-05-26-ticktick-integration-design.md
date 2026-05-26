# TickTick 任务管理集成 — 设计说明书

## 概述

在现有考研高数错题本 Electron 应用中，新增一个完整的 TickTick 风格任务管理系统。通过顶部 Toggle 在"错题本模式"和"TickTick 模式"之间切换，两边通过桥接表实现深关联双向同步。

## 架构

### 迷你应用架构

TickTick 作为独立子系统运行，拥有自己的 Shell 组件、子路由、Service 层、数据库表。通过模式 Toggle 和桥接层与错题本联通。

```
Renderer:
  Shell (mode: 'mistake' | 'ticktick')
    ├── 错题本模式 → 现有 14 个页面
    └── TickTick 模式 → TickTickShell
                          ├── TodayPage
                          ├── CalendarPage
                          ├── ListDetailPage
                          ├── FocusTimerPage (新版，复用)
                          ├── [Phase 2] KanbanPage
                          ├── [Phase 2] EisenhowerPage
                          ├── [Phase 2] HabitsPage
                          └── TickTickSettingsPage

Main Process:
  IPC Dispatcher
    ├── 错题本 Services (现有 13 个)
    ├── TickTick Services (新建 4 个)
    │     ├── ticktickTaskService
    │     ├── ticktickCalendarService
    │     ├── ticktickHabitService (Phase 2)
    │     └── bridgeService (同步)
    └── deepseekService (共享)

SQLite:
  ├── 错题本表 (18 tables, 不动)
  ├── TickTick 表 (8 tables)
  └── Bridge 表 (1 table)
```

### 模式切换

- Shell 顶部品牌区下方放 Toggle："错题本" | "TickTick"
- 切换时替换整个侧边栏导航和主内容区
- 跨模式保留状态：专注计时器、全局搜索
- 专注计时器 mini bar 两种模式下都显示

## 数据库新增表

### Phase 1 表

```sql
-- 任务清单/文件夹
CREATE TABLE ticktick_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#4a90d9',
  icon TEXT DEFAULT 'list',
  sort_order INTEGER DEFAULT 0,
  is_folder INTEGER DEFAULT 0,
  parent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 任务（含子任务、重复、标签）
CREATE TABLE ticktick_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  due_date TEXT,
  due_time TEXT,
  priority TEXT CHECK(priority IN ('none','低','中','高')) DEFAULT 'none',
  is_completed INTEGER DEFAULT 0,
  completed_at TEXT,
  parent_id TEXT,           -- 子任务父级
  sort_order INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',   -- JSON array
  recurrence_rule TEXT,     -- "daily" | "weekly:1,3,5" | "monthly:15"
  estimated_minutes INTEGER DEFAULT 0,
  actual_minutes INTEGER DEFAULT 0,
  pomodoro_sessions INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual',  -- manual | auto_review | ai_plan
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 标签
CREATE TABLE ticktick_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#999'
);

-- 番茄钟会话
CREATE TABLE ticktick_focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER NOT NULL,
  session_type TEXT CHECK(session_type IN ('focus','short_break','long_break')) DEFAULT 'focus',
  completed INTEGER DEFAULT 1,
  white_noise TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 桥接表（TickTick ↔ 错题本）
CREATE TABLE ticktick_bridge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticktick_task_id TEXT NOT NULL,
  linked_type TEXT NOT NULL CHECK(linked_type IN ('question','knowledge_point','subject','study_task')),
  linked_id TEXT NOT NULL,
  sync_review INTEGER DEFAULT 1,
  sync_mastery INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AI 生成的日计划
CREATE TABLE ticktick_ai_plans (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  tasks_json TEXT NOT NULL,  -- JSON array of task objects
  accepted_count INTEGER DEFAULT 0,
  reviewed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Phase 2 表（后期）

```sql
CREATE TABLE ticktick_habits (...);
CREATE TABLE ticktick_habit_logs (...);
```

## UI 设计语言

对标 TickTick 桌面端设计，实现时使用 `frontend-design` skill 保证视觉质量。

### 配色

| 角色 | 色值 | 用途 |
|------|------|------|
| 主色 | `#ff6b35` | 今天/活跃/番茄/强调按钮/选中态 |
| 背景 | `#ffffff` | 主内容区背景 |
| 侧栏背景 | `#fafafa` | 侧边栏背景 |
| 输入框背景 | `#f5f5f5` | Quick Add 输入框 |
| 主文字 | `#333333` | 任务标题、导航 |
| 次要文字 | `#999999` | 元信息、时间、标签 |
| 分隔线 | `#eeeeee` / `#f0f0f0` | 侧栏分隔、任务组之间 |
| 过期红 | `#e53935` | 过期标记 |
| 清单色 | `#4a90d9` / `#7c4dff` / `#26a69a` | 各清单彩色圆点 |

### 字体层级

- 页面标题 18px / font-weight 700
- 任务名 13px / font-weight 400
- 侧边栏项 12px
- 分组标签 12px / font-weight 600
- 元信息 11px（清单、日期、标签）
- 小标签 10px（计数 badge）

### 圆角与间距

- 任务行 8px 圆角，行间距 2px（紧凑）
- 侧边栏项 6px 圆角，项间距 4px
- 按钮 6-8px 圆角
- 卡片 8px 圆角
- 分组区块间距 12px

### 交互细节

- 勾选圆圈：默认 2px #ddd 边框，hover 变橙色边框，点击后填充 #ff6b35 + 白色对勾 + 文字删除线
- 任务行：hover 时出现浅灰背景 + 拖拽手柄 + 操作按钮
- Quick Add：focus 时边框从 transparent 变 #ff6b35
- 分组折叠：点击分组标题收起/展开，箭头旋转动画
- 侧边栏：选中项高亮橙色背景 #fff0e8

### 双主题

现有错题本是暗色主题。新增 CSS 变量体系同时支持 light/dark，整个 App（错题本 + TickTick）统一切换。TickTick 模式默认浅色，错题本模式默认暗色，两边可通过设置切换。

### 清单色彩系统

清单通过彩色圆点区分，预置色板：蓝 #4a90d9、紫 #7c4dff、青 #26a69a、粉 #ec407a、黄 #ffa726、绿 #66bb6a。用户创建清单时可自定义颜色。

## TickTick 页面设计

### 侧边栏导航

```
✅ 任务管理

核心：
  📋 今天
  📅 日历
  📥 收集箱

清单：
  📘 考研数学
  📗 专业课
  💼 个人

视图：[Phase 2]
  📊 看板
  🎯 艾森豪威尔

效率：
  ✅ 习惯打卡 [Phase 2]
  ⏱️ 专注计时

工具：
  ⚙️ 设置
```

### TodayPage（默认首页）

- **Quick Add Bar**：顶部自然语言输入框，输入"明天下午3点复习高数 #考研 @数学 !!高"
- **智能分组**：过期任务 → 今天 → 今晚 → 即将到来 → 无日期，每组可折叠
- **任务行**：勾选框 + 标题 + 元信息（清单/标签/关联错题数/子任务进度/番茄数）+ 优先级标记 + 日期时间
- **内联展开**：点击任务展开右侧详情面板，编辑所有字段、管理子任务、关联错题
- **拖拽排序**：任务行可上下拖拽调整排序
- **右键菜单**：完成/编辑/修改日期/移动清单/删除

### CalendarPage

- **三视图**：月/周/日切换
- **月视图**：7列网格，每格显示任务数 + 复习到期数 + 番茄数
- **错题复习标记**：红色显示到期复习数量，数据来自 question.next_review_at
- **拖拽排期**：从侧边栏未排期区拖入日期格子
- **日期导航**：左右翻月，"今天"按钮回到当前

### NLP 日期解析规则

纯前端规则引擎实现，不依赖 AI：

| 输入 | 解析 | 示例 |
|------|------|------|
| 日期词 | due_date | 今天、明天、后天、下周三、下个月5号、5月30日、3天后 |
| 时间词 | due_time | 下午3点、晚上8点、15:00、早上9点半 |
| !!高 / !!中 / !!低 | priority | "复习线代 !!高" → priority=高 |
| #标签 | tags | "#考研 #数学" → tags=["考研","数学"] |
| @清单名 | list_id | "@考研数学 刷题" → 归入考研数学清单 |
| 每天/每周/每月 | recurrence | "每天背单词" → 每日重复 |
| 预计N分钟 | estimated | "预计45分钟" → estimated_minutes=45 |

## 专注计时器重设计

对标 TickTick Pomodoro Timer，替换现有 FocusTimerPage。

### 核心功能

- **环形 SVG 倒计时**：颜色随状态变化（专注=橙 #ff9800、休息=绿 #4caf50、暂停=灰）
- **番茄钟周期**：可配置专注时长(默认25分)、短休息(5分)、长休息(15分)、每4轮长休息
- **白噪音**：雨声、溪流、咖啡馆、白噪音、森林鸟鸣、无 — 用 Web Audio API 生成
- **跨模式**：错题本和 TickTick 模式共享同一个计时器实例
- **结算面板**：结束 → 选择绑定目标和结算方式 → 写入同步

### 绑定逻辑

| 绑定目标 | 结算时写入 |
|----------|-----------|
| TickTick 任务 | ticktick_focus_sessions + task.actual_minutes + task.pomodoro_sessions |
| 错题复习 (Question) | study_sessions + review_logs（通过 bridge） |
| 错题本 StudyTask | study_sessions + bridge → 更新 TickTick 关联任务进度 |
| 无绑定（自由计时） | 仅 study_sessions |

## AI 功能

复用现有 DeepSeek API 集成，三个功能共用一个管道：收集上下文 → 构建 Prompt → DeepSeek → JSON 解析校验 → 用户预览确认 → 写入。

### 1. 智能任务拆解

- 输入：模糊目标文字（如"复习完高数上册"）+ 可选上下文
- 输出：结构化子任务列表，每个带标题/预计天数/标签/关联知识点
- 确认：用户勾选需要的子任务，一键批量创建

### 2. AI 每日计划

- 输入上下文：日历空闲时段 + 过期任务 + 到期复习列表 + 掌握度薄弱点排名 + 考试日期 + 每日目标 + 前一天完成率
- 输出：时间分块建议任务列表，带优先级和关联错题
- 确认：用户审核后一键添加到 Today

### 3. AI 复盘（每日 + 每周）

- 每日：分析今日完成率、专注时长、错题复习结果分布 → 自然语言总结 + 明天建议
- 每周：7天完成趋势、专注总时长、掌握度变化、连续打卡 → 下周学习方向

## 双向同步

通过 `ticktick_bridge` 桥接表实现，所有跨模式写入通过 BridgeService 统一处理。

### 四条同步路径

1. **TickTick → 错题本**：TickTick 任务完成 → 写入 review_logs + 更新 question.next_review_at（sync_review=1 时）
2. **错题本 → TickTick**：错题复习到期 → 自动生成 TickTick Today 任务（source=auto_review）
3. **掌握度 → 计划**：掌握度上升 → 关联任务优先级下调；掌握度下降 → 优先级上调（sync_mastery=1 时）
4. **学习时长 → 统计**：TickTick 专注产生的 study_sessions 计入 Dashboard 的今日学习时长

### 触发事件

| 事件 | 触发条件 | 执行动作 |
|------|---------|---------|
| task.completed | TickTick 任务完成 + bridge + sync_review=1 | 写 review_logs，更新 next_review_at |
| review.updated | 错题本完成复习 + bridge | 更新 TickTick 关联任务进度 |
| mastery.changed | 掌握度变化 + sync_mastery=1 | 调整关联任务优先级 |
| daily.rollover | 每天启动时检查 | 自动创建到期复习任务 |
| focus.saved | 任何模式专注计时结束 | 写入 study_sessions，更新两边统计 |

## Phase 划分

### Phase 1（本次实现）

- 模式切换 Toggle + TickTickShell + TickTickSidebar
- 数据库：ticktick_lists, ticktick_tasks, ticktick_tags, ticktick_focus_sessions, ticktick_bridge, ticktick_ai_plans
- 页面：TodayPage, CalendarPage, ListDetailPage, TickTickSettingsPage
- NLP 日期解析规则引擎
- 新版专注计时器（替换旧版）
- 桥接表 + BridgeService + 四条同步路径
- AI 三大功能（拆解/日计划/复盘）

### Phase 2（后续）

- 看板视图 (KanbanPage)
- 艾森豪威尔矩阵 (EisenhowerPage)
- 习惯打卡 (HabitsPage + ticktick_habits 表)
- 更多视图优化

## 新增文件清单

### Main Process
- `src/main/services/ticktickTaskService.ts`
- `src/main/services/ticktickCalendarService.ts`
- `src/main/services/bridgeService.ts`
- `src/main/database/ticktickSchema.ts`（或扩展 schema.ts）
- `src/main/services/nlpDateParser.ts`

### Renderer
- `src/renderer/pages/ticktick/TickTickShell.tsx`
- `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- `src/renderer/pages/ticktick/TodayPage.tsx`
- `src/renderer/pages/ticktick/CalendarPage.tsx`
- `src/renderer/pages/ticktick/ListDetailPage.tsx`
- `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`
- `src/renderer/pages/ticktick/FocusTimerPage.tsx`（重写，替换旧版）
- `src/renderer/components/TickTick/TaskRow.tsx`
- `src/renderer/components/TickTick/QuickAddBar.tsx`
- `src/renderer/components/TickTick/TaskDetailPanel.tsx`
- `src/renderer/components/TickTick/RingTimer.tsx`
- `src/renderer/components/TickTick/AiPlanPanel.tsx`
- `src/renderer/components/TickTick/WhiteNoisePicker.tsx`
- `src/renderer/styles/ticktick.css`
- `src/renderer/utils/nlpDateParser.ts`（前端部分）

### Shared Types
- 扩展 `src/shared/types.ts`：新增 TickTick 相关类型定义
- 扩展 `src/shared/api.ts`：新增 TickTick IPC 方法

### Phase 2 文件
- `src/renderer/pages/ticktick/KanbanPage.tsx`
- `src/renderer/pages/ticktick/EisenhowerPage.tsx`
- `src/renderer/pages/ticktick/HabitsPage.tsx`
- `src/main/services/ticktickHabitService.ts`

## 非功能需求

- 所有 TickTick 数据存同一 SQLite 文件，不加新数据库
- NLP 解析纯前端规则引擎，不调 API
- AI 功能复用现有 DeepSeek API 密钥配置
- 专注计时器跨模式状态存 localStorage
- 不引入新的 npm 依赖（除非必要）
