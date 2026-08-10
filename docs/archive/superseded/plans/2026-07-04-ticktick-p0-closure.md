# TickTick P0 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-validate and close TickTick P0 issues by confirming current layout fixes, addressing any remaining blockers with minimal changes, and syncing the status documentation to the true post-verification state.

**Architecture:** Treat TickTick P0 closure as a narrow stabilization pass, not a feature build. First verify the existing code paths for layout, sidebar tooling visibility, and startup workaround behavior; then apply only the smallest fixes required; finally sync the active docs so they reflect the real validated state rather than stale pre-fix wording.

**Tech Stack:** Electron, React, TypeScript, existing TickTick renderer pages/styles, Markdown docs, current `npm run typecheck` / `npm run build`

---

## Background

配套设计：`../specs/2026-07-02-ticktick-p0-closure-design.md`。该 spec 的 P0 重新验收结论：

- `P0-1` 主内容区宽度塌陷：源码核对显示**代码已修，待重新验收**（`src/renderer/App.tsx` 已用 `ticktick-root`+`TickTickShell`，`ticktick.css` 已补齐 min-width/height/overflow）。
- `P0-2` 侧边栏工具区定位：源码核对显示**代码已修，待重新验收**（`TickTickSidebar.tsx` 已移除 inline `marginTop:auto`，改用 `.tt-sidebar-scroll`/`.tt-sidebar-tools`）。
- `P0-3` 打包版 exe 启动：主要是**环境 / workaround / 文档收口**问题，不必然是代码修复项。

因此本轮的正确形态是三步收口，而非重构：**先重新验收 → 仅对确证失败做最小修复 → 文档收口**，把 `TICKTICK_KNOWN_BUGS.md` / `KNOWN_ISSUES.md` / `ROADMAP.md` 里“待修复”的表述改到经验收确认的真实状态，并明确区分“已修并已验收”与“仍开放”。

**关键预期**：若 Task 1 验收显示 P0-1/P0-2 均已生效，则 Task 2（代码修复）可整体跳过，本轮主要落在“确认 + 文档收口”；不得因文件已打开就顺手扩成 shell 重构或 P1/P2。

## Non-Goals

- No TickTick P1 data-integrity work in this plan.
- No TickTick P2 / Phase 2 feature work.
- No renderer test framework or E2E framework introduction.
- No large architecture refactors (`databaseService.ts`, `registerIpc.ts`, shell redesign beyond P0 needs).

## Scope

### In Scope

- TickTick root layout / main-content visibility
- TickTick sidebar tools positioning
- TickTick P0 page visibility validation scope:
  - Today
  - Calendar
  - Inbox
  - List Detail
  - Focus
  - Settings
- exe / `ELECTRON_RUN_AS_NODE` workaround and documentation closure
- Active P0-facing docs:
  - `TICKTICK_KNOWN_BUGS.md`
  - `KNOWN_ISSUES.md`
  - `ROADMAP.md`

### Out of Scope

- TickTick P1/P2 implementation
- Widget deeper feature work
- broader product roadmap reshaping

## Proposed Approach

### Approach A — Verify, patch minimally, then sync docs (recommended)

Re-run a focused P0 acceptance pass first, treat code as potentially already fixed, and only patch concrete failures found during that pass. Once verified, update the docs from “待修复” to the correct state.

### Approach B — Rewrite TickTick shell preemptively

Higher risk and unnecessary if the current code already resolves the original P0 issues.

### Approach C — Update docs based only on code inspection

Too weak. P0 is about visible behavior and startup behavior, so doc closure without fresh acceptance would be unreliable.

## Risks

- Code inspection may overestimate readiness if packaged/manual behavior still differs from local expectations.
- The exe startup issue may remain environment-dependent and require wording discipline rather than code changes.
- It is easy to let this expand into P1/P2 once TickTick files are open; that must be resisted.

## Acceptance Criteria

- TickTick main content renders at normal width across the P0 validation pages.
- Sidebar tools remain visible without having to scroll to the bottom.
- Any remaining P0 code issue is fixed with the smallest viable change.
- P0-facing docs accurately reflect the post-validation state.
- `npm run typecheck` and `npm run build` pass after any code/doc changes.

## Task Breakdown

### Task 1: Re-accept current TickTick P0 behavior

**Files:**
- Review: `src/renderer/App.tsx`
- Review: `src/renderer/pages/ticktick/TickTickShell.tsx`
- Review: `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- Review: `src/renderer/styles/ticktick.css`
- Review: `TICKTICK_KNOWN_BUGS.md`
- Review: `KNOWN_ISSUES.md`
- Review: `ROADMAP.md`

**Interfaces:**
- Consumes: current TickTick layout and startup behavior
- Produces: a validated P0 status matrix: fixed-and-accepted / still broken / workaround-only

- [ ] **Step 1: Re-check the code paths identified in the P0 design**

Review the current TickTick layout and sidebar code and confirm the expected P0 mechanisms are still present. Anchor points from source review (confirm they still hold, do not assume):

```text
App.tsx: TickTick 分支外层为 className="ticktick-root" 且渲染 <TickTickShell>（不再复用旧 .app-shell）
ticktick.css: .ticktick-root / .ticktick-app-shell / .ticktick-main / .ticktick-main-content 具备 min-width:0 / min-height:0 / overflow 规则
TickTickSidebar.tsx: 中间列表包在 .tt-sidebar-scroll，工具区为 .tt-sidebar-tools，无 inline marginTop:'auto'
ticktick.css: .tt-sidebar-scroll (flex:1/min-height:0/overflow-y:auto) 与 .tt-sidebar-tools (flex-shrink:0) 存在
```

产出：一张 P0 状态矩阵（fixed-and-accepted / still broken / workaround-only），驱动 Task 2 是否需要执行。

- [ ] **Step 2: Run focused manual P0 acceptance**

Validate these visible pages in TickTick mode:

```text
Today
Calendar
Inbox
List Detail
Focus
Settings
```

Confirm:

```text
main content uses full width to the right of the sidebar
no full-window horizontal overflow
sidebar tools are visible without scrolling to the document bottom
Focus/Settings open in the right pane
```

- [ ] **Step 3: Validate startup workaround state**

Check the packaged startup environment closure path:

```text
ELECTRON_RUN_AS_NODE presence/absence
whether workaround instructions still match reality
whether code changes are actually needed or docs are sufficient
```

### Task 2: Apply only the minimal P0 code fix if Task 1 finds a real failure

> **CONDITIONAL — 默认跳过**：仅当 Task 1 验收发现具体可复现的 P0 失败时才执行本任务。若 P0-1/P0-2 均通过验收，整个 Task 2 跳过，并在 Task 3 文档收口里记录“经验收无需代码改动”。不得把本任务当作重构或清理入口。

**Files:**
- Modify (conditional): `src/renderer/App.tsx`
- Modify (conditional): `src/renderer/pages/ticktick/TickTickSidebar.tsx`
- Modify (conditional): `src/renderer/styles/ticktick.css`

**Interfaces:**
- Consumes: concrete failure from Task 1
- Produces: smallest viable P0 fix (or: no change if Task 1 fully passed)

- [ ] **Step 1: Reproduce the exact remaining failure**

Document the specific still-broken symptom before editing:

```text
layout width collapse
sidebar tools placement
page switch visibility
```

- [ ] **Step 2: Implement the smallest fix**

Limit edits to the exact failure path. Do not opportunistically clean up P1/P2 issues in this task.

- [ ] **Step 3: Re-run focused manual acceptance**

Re-check the same P0 pages and confirm the concrete failure is gone.

### Task 3: Sync P0-facing docs to the validated state

**Files:**
- Modify: `TICKTICK_KNOWN_BUGS.md`
- Modify: `KNOWN_ISSUES.md`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: validated P0 status from Task 1/2
- Produces: accurate public/internal status docs

- [ ] **Step 1: Update P0-1 / P0-2 wording based on actual acceptance result**

Move each item from “待修复” to the correct state only if it passed fresh acceptance. 需同步的现存陈述：

```text
TICKTICK_KNOWN_BUGS.md: "P0：TickTick 主界面空白，主内容区宽度被挤成 12px" 与 "P0：专注计时和设置被挤到侧边栏很下面" 两节的“当前状态/现象”
KNOWN_ISSUES.md: "P0：布局与启动" 下的“主内容区宽度被挤成约 12px”条目
ROADMAP.md: "TickTick P0 / P1 修复" 段的“主界面布局修复”条目
```

若已通过验收，改为“已修复并经 P0 页面验收”，并保留 P0-3 与其它未闭环项的真实状态；不要整节删除以保留可追溯历史。

- [ ] **Step 2: Keep P0-3 distinguished as workaround/documentation closure if still environment-bound**

Do not overstate startup behavior as a code fix if it is still mainly an environment/workaround issue. `ELECTRON_RUN_AS_NODE` 清理说明与验收步骤应保留为 workaround/文档收口口径。

- [ ] **Step 3: Keep P1/P2 wording untouched except for directly adjacent phrasing made false by P0 closure**

This remains a P0 plan, not a full TickTick doc rewrite. 三份文档里的 P1/P2 条目一律不动，除非某句因 P0 闭环而直接变假。

### Task 4: Verify and commit

**Files:**
- Review: all modified files from Tasks 1-3

- [ ] **Step 1: Run required verification**

Run:

```bash
npm run typecheck
npm run build
```

Expected:

```text
typecheck passes
build passes
```

- [ ] **Step 2: Check diff scope**

Run:

```bash
git diff -- src/renderer/App.tsx src/renderer/pages/ticktick/TickTickShell.tsx src/renderer/pages/ticktick/TickTickSidebar.tsx src/renderer/styles/ticktick.css TICKTICK_KNOWN_BUGS.md KNOWN_ISSUES.md ROADMAP.md
```

Expected:

```text
only P0 closure code/doc changes
```

- [ ] **Step 3: Commit**

若 Task 2 跳过，仅提交文档改动；若 Task 2 执行了最小修复，一并提交对应源码。仅 `git add` 本轮实际改动的文件：

```bash
git add TICKTICK_KNOWN_BUGS.md KNOWN_ISSUES.md ROADMAP.md   # 若 Task 2 有改动再追加对应 src 文件
git commit -m "fix: close TickTick P0 issues"
```

## Verification

- Focused manual TickTick page acceptance for P0 pages
- `npm run typecheck`
- `npm run build`
- Narrow diff review to ensure P0-only closure
