# Phase 3 完整改动汇报

**执行者：Claude Code（Claude Opus 4.7）**

**日期：2026年5月26日-29日**

**目标：Phase 3 功能开发 + 已有问题修复 + 多轮审查**

**当前状态：⚠️ 打包后 exe 打开显示空白页面，根因未定位**

---

## 一、改动总览

17 个文件变更，+779 / -121 行，9 个 commits。

### 涉及的模块

| 模块 | 文件 | 改动内容 |
|------|------|---------|
| **日历周/日视图** | `CalendarPage.tsx` | 从占位符变成真实视图，支持翻页导航 |
| **反向同步 IPC** | `registerIpc.ts`, `api.ts`, `preload.ts`, `DetailPage.tsx`, `ReviewPage.tsx` | Path 2(复习→TickTick任务) + Path 3(掌握度→优先级)全部接线 |
| **右键菜单** | `ContextMenu.tsx`(新), `TaskRow.tsx`, `KanbanPage.tsx`, `ListDetailPage.tsx` | 右键出菜单：完成/编辑/移动/删除，支持子菜单 |
| **桌面悬浮窗** | `DesktopWidget.tsx`(新), `registerIpc.ts`, `api.ts`, `preload.ts`, `App.tsx`, `TickTickSidebar.tsx` | 独立 Electron BrowserWindow，番茄钟+任务+设置 |
| **资料进度 UX** | `StudyMaterialsPage.tsx`, `studySupervisorService.ts` | 加减按钮、toast、校验、颜色、建议节奏显示等18项 |
| **建议节奏计算** | `studySupervisorService.ts` | critical 等级、grace period、文案优化、离散单位取整 |
| **总审查修复** | `bridgeService.ts`, `CalendarPage.tsx`, `ContextMenu.tsx`, `App.tsx` | 5个Critical修复 |

---

## 二、详细改动清单

### 1. 日历周/日视图 (Commit: 7366af1)

**文件**: `src/renderer/pages/ticktick/CalendarPage.tsx` (+157行)

- 添加 `weekTasks`/`dayTasks`/`weekLoading`/`dayLoading` state
- 计算 `currentWeekMonday`（当周周一），7列展示
- 每列显示最多10条未完成任务，超过显示"+N 更多"
- 日视图显示时间线格式的任务列表
- 加载数据：`listTickTickTasks({ dueDate: date })` 分别加载周和日

### 2. 反向同步 IPC (Commit: 6fa0db1)

**文件**: `registerIpc.ts`, `api.ts`, `preload.ts`, `DetailPage.tsx`, `ReviewPage.tsx` (+27行)

- `registerIpc.ts`: 加 `syncReviewToTickTickTask` 和 `syncMasteryToTaskPriority` 两个 handler
- `api.ts`: 加 `syncReviewToTickTick` 和 `syncMasteryToTickTick` 方法
- `preload.ts`: 暴露两个 API
- `DetailPage.tsx`: 掌握度变更后调 `syncMasteryToTickTick`；复习后调 `syncReviewToTickTick`
- `ReviewPage.tsx`: 复习提交后调 `syncReviewToTickTick`

### 3. 右键菜单 (Commit: bef56e0)

**文件**: `ContextMenu.tsx`(新, 140行), `TaskRow.tsx`, `KanbanPage.tsx`, `ListDetailPage.tsx`

- `ContextMenu.tsx`: 新组件，支持定位、点击外部关闭、滚动关闭、视口边界修正、子菜单
- `TaskRow.tsx`: 加 `onContextMenu`、可选的 `onEdit/onDelete/onMove/lists` props
- `KanbanPage.tsx`: 卡片上加右键菜单（完成/编辑/移动/删除）
- `ListDetailPage.tsx`: 传 `onEdit/onDelete/onMove` 给 TaskRow

### 4. 桌面悬浮窗 (Commit: 4ed01d0)

**文件**: `DesktopWidget.tsx`(新, 156行), `registerIpc.ts`, `App.tsx`, `TickTickSidebar.tsx`, `ticktick.css`

**主进程** (`registerIpc.ts` +65行):
```
import path from 'node:path';           // 新加
import { app, BrowserWindow, ipcMain, screen } from 'electron';  // 新加了 app, BrowserWindow, screen

const isDev = !app.isPackaged && ...;    // 新加的模块级变量
let widgetWindow: BrowserWindow | null = null;

function createWidgetWindow() { ... }    // 创建 frameless/transparent/alwaysOnTop 窗口

ipcMain.on('widget:open', ...)          // 6个IPC handler
ipcMain.on('widget:close', ...)
ipcMain.on('widget:togglePin', ...)
ipcMain.on('widget:setOpacity', ...)
ipcMain.on('widget:setSize', ...)
handle('widget:isOpen', ...)
```

**前端** (`DesktopWidget.tsx`):
- 番茄钟环从 localStorage 读取 `kaoyan-ticktick-timer-state`
- 今日任务从 `getTodayTickTickTasks()` 获取
- 设置面板：深色模式/透明度/字体大小
- 图钉按钮切换置顶

**App.tsx** 改动:
```
import React, { ... } from 'react';        // 新加了 React 导入
const DesktopWidget = React.lazy(() =>      // 模块顶层 lazy import
  import('./pages/ticktick/DesktopWidget')
    .then(m => ({ default: m.DesktopWidget }))
);

// 在所有 hooks 之后：
if (window.location.hash === '#/widget') {
  return (
    <React.Suspense fallback={...}>
      <DesktopWidget />
    </React.Suspense>
  );
}
```

⚠️ **重要**：最初版 Widget 的 return 在 hooks 之前（违反 React 规则），已移到 hooks 之后。最初版是顶层静态 import，后改为 `React.lazy` 懒加载以避免主窗口加载 Widget 模块。

### 5. 资料进度 UX 优化 (Commit: a202df9)

**文件**: `StudyMaterialsPage.tsx` (+51/-21行)

- 进度输入旁加 +/- 按钮
- 更新后 toast 反馈
- `current_amount > total_amount` 校验
- 卡片底部 grid 从 3列 改为 2列
- 风险筛选改为单级选项
- "正常"标签改用绿色
- 建议节奏提到进度条下方
- 删除确认文案优化
- 进度条颜色随 riskLevel 变化
- 成功消息自动消失
- 输入框宽度调整
- 材料类型加"习题集""教辅"

### 6. 建议节奏计算 (Commit: d1cbe2b)

**文件**: `studySupervisorService.ts` (+64/-修改行)

- 新增 `critical` 风险等级（lagRatio >= 0.3）
- 没开始学的 3 天 grace period
- catchUpText 改用"每天多学 X 讲，Y 天后赶上"
- 低频建议统一"每周 N 讲"
- 离散单位 lagAmount 取整

### 7. 总审查修复 (Commits: 9a7acb3, aa7bd67, 122e8de)

**文件**: `bridgeService.ts`, `CalendarPage.tsx`, `ContextMenu.tsx`, `App.tsx`

- 反向同步标记任务为完成（之前只更新 timestamp）
- 日历周/日视图加翻页导航（weekOffset/dayOffset state + 左右箭头按钮）
- 子菜单视口边界修正
- 移除死 import（TickTickSidebar, formatSeconds）
- Widget return 从 hooks 前移到 hooks 后
- Widget 从静态 import 改为 React.lazy

---

## 三、白屏问题排查记录

1. **第一次排查**：Widget return 在 hooks 之前 → 已修复（移到 hooks 之后）
2. **第二次排查**：DesktopWidget 静态 import 可能拖垮主 App → 已改为 React.lazy
3. **已验证通过**：
   - `npx tsc --noEmit` — 零错误
   - `npx tsc -p tsconfig.main.json --noEmit` — 零错误
   - `npm run build` — 成功（1790 modules, 3.3s）
   - `npm run pack:win` — 成功（exe 生成正常）
   - Electron 启动验证（之前测试过 `require("electron").app` OK）

4. **尚未排查**：
   - 渲染进程 JS bundle 的运行时错误（无法在打包环境看 DevTools console）
   - 主进程的 `screen` 模块在打包后是否可用
   - `registerIpc.ts` 新增的 `const isDev = !app.isPackaged && ...` 在模块顶层是否影响了初始化顺序
   - asar 打包后文件路径 `__dirname + '../../../renderer/index.html'` 是否正确

---

## 四、最可疑的改动

按可能性排序：

1. **`registerIpc.ts` 的 widget 代码** — 这是最大的改动（+65行），加了 `app`/`BrowserWindow`/`screen` 导入，加了模块级 `isDev` 变量，加了 `createWidgetWindow` 函数。如果 `screen` 在 Electron 主进程的特定初始化阶段不可用，会导致整个模块加载失败 → 主进程无法完成 IPC 注册 → 渲染进程白屏。

2. **`App.tsx` 的 `React.lazy`** — `import React from 'react'` 是新加的。Vite + React 18 用 automatic JSX runtime 不需要显式 import React。加了之后可能有冲突。

3. **`DesktopWidget.tsx` 的模块加载** — `React.lazy` 分出来了，但它本身可能有 import 错误。

---

## 五、建议 Codex 检查

1. 临时注释掉 `registerIpc.ts` 的所有 Widget 相关代码（import + isDev + createWidgetWindow + 6个handler），重新打包测试白屏是否消失
2. 如果白屏消失，逐步加回 Widget 代码定位具体是哪个 import/调用导致的
3. 如果白屏还在，检查 `App.tsx` 的 `import React` 是否与 Vite 的 automatic JSX runtime 冲突
4. 检查 asar 包中的 `dist/renderer/index.html` 的 JS/CSS 路径是否正确
