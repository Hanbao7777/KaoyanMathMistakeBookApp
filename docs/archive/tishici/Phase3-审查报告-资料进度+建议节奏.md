# Phase 3 审查报告：资料进度 + 建议节奏

**审查者：Claude Code（Anthropic Claude Opus 4.7）**

**日期：2026年5月26日**

---

## 一、资料进度页面 UX 问题（13 项）

> 审查文件：`src/renderer/pages/StudyMaterialsPage.tsx`、`src/main/services/studySupervisorService.ts`

### 严重（5 项）

| # | 问题 | 行号 | 场景 |
|---|------|------|------|
| 1 | 进度更新只能输绝对值，没有增量方式 | `StudyMaterialsPage.tsx:209` | 用户从第3讲到第5讲，想输入 +2，结果把进度从3改成2 |
| 2 | 更新完进度完全静默，没 toast | `StudyMaterialsPage.tsx:106-111` | blur 后页面无反应，不知道成功了没 |
| 3 | `current_amount > total_amount` 没前端校验 | `StudyMaterialsPage.tsx:64-79` | 手误输了 20/18，保存成功，进度 111% |
| 4 | 卡片底部 4 项信息塞进 `repeat(3, 1fr)` | `StudyMaterialsPage.tsx:197-202` | 第4项孤零零换行，像 bug |
| 5 | 风险筛选缺少 critical 层级，语义不清 | `StudyMaterialsPage.tsx:171-178` | "只看落后" 不知道包含哪些等级 |

### 中等（5 项）

| # | 问题 | 行号 | 场景 |
|---|------|------|------|
| 6 | "正常"标签用蓝色不符合直觉 | `StudyMaterialsPage.tsx:190` | 考研人直觉：绿色=OK，蓝色=信息 |
| 7 | "建议节奏"藏在底部小格子 | `StudyMaterialsPage.tsx:199` | 每天最重要的信息字号小、颜色灰 |
| 8 | 删除确认用技术行话 | `StudyMaterialsPage.tsx:100` | "关联任务不会崩溃""软删除"对普通用户不友好 |
| 9 | 进度条全是蓝色，不随 riskLevel 变色 | `StudyMaterialsPage.tsx:196` | 一眼看不出哪些资料落后 |
| 10 | lagAmount 浮点数对离散单位无意义 | `studySupervisorService.ts:97` | "落后 2.7 讲"不可理解 |

### 轻微（3 项）

| # | 问题 | 行号 | 场景 |
|---|------|------|------|
| 11 | 成功提示绿条永不消失 | `StudyMaterialsPage.tsx:218` | 越来越碍眼，只能刷新清除 |
| 12 | "快速更新进度"输入框太窄（180px） | `global.css:6069-6071` | 4位数学不进 |
| 13 | 材料类型预设跟考研实际不匹配 | `StudyMaterialsPage.tsx:8-9` | 《张宇18讲》找不到匹配的分类 |

---

## 二、建议节奏计算逻辑问题（5 项）

> 审查文件：`src/main/services/studySupervisorService.ts`，`materialRisk()` 函数（L70-132）

### 1. `critical` 风险等级从未被赋值

**代码：** L98-102

```typescript
if (lagRatio >= 0.2) riskLevel = 'danger';   // 落后 20%+
else if (lagRatio >= 0.1) riskLevel = 'warning'; // 落后 10%+
else if (lagAmount > 0) riskLevel = 'normal';
// critical 永远不会出现
```

类型定义了 `'normal' | 'warning' | 'danger' | 'critical'` 四级，但 `critical` 分支缺失。如果你的资料落后 50% 以上，仍只标 `danger`。

**修法：** 增加 `if (lagRatio >= 0.3) riskLevel = 'critical';`

### 2. 线性插值不考虑"还没开始学"

**代码：** L94-101

`current_amount = 0` + `start_date` 已过 10 天 → `expectedAmount` 算出来 ≠ 0 → `lagAmount` 巨大 → 标 danger。但用户可能只是买了资料还没打开。

**修法：** 加判断 `current === 0 && elapsedDays <= 3` → 暂不评级。

### 3. catchUpText 文案表述模糊

**代码：** L116-120

"本周额外补 1-3 讲，之后按建议每日 2 讲推进" — 用户要读两遍才懂。"本周"指自然周还是从今天起 7 天？没有交代。

**修法：** 改成 "每天多学 X 讲，Y 天后可赶上目标进度"。

### 4. catchUpMax 被 `Math.min` 限死

**代码：** L117

```typescript
catchUpMax = Math.max(1, Math.min(Math.ceil(lagAmount), suggestedDailyAmount ?? 2))
```

如果落后 10 讲、每天建议 2 讲 → `Math.min(10, 2)` → `catchUpMax = 2`。文案只说"本周额外补 1-2 讲"，没说需要 5 天才能补完。用户会以为 2 讲就补完了。

**修法：** 不算 max/min，直接给真实追赶量和所需天数。

### 5. dailyNeed < 1 时的低频建议不直观

**代码：** L108-111

```typescript
suggestedPaceText = everyDays <= 7 ? `约每 ${everyDays} 天完成 1 ${unit}` : `每周约 ${weeklyNeed} ${unit}`;
```

"约每 3 天完成 1 讲" 和 "每周约 2 讲" 混用，用户认知负担重。

**修法：** 统一用 "每周 N 讲"。

---

## 三、Phase 3 已完成项

| 项目 | 状态 |
|------|------|
| DailyPlanPage 过期完成清除 | ✅ 已修 |
| 旧计时器替换为新版番茄钟 | ✅ 已修 |
| 深色模式开关 | ✅ 已修 |

## 四、Phase 3 待定项

| 项目 | 状态 |
|------|------|
| 资料进度页面 UX 修复（13 项） | ⏳ 待确认 |
| 建议节奏计算逻辑修复（5 项） | ⏳ 待确认 |
| 日历周/日视图 | ⏳ 待实现 |
| 反向同步 Path 2+3 IPC 接线 | ⏳ 待实现 |
| 右键上下文菜单 | ⏳ 待实现 |
