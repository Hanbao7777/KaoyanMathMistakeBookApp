# CI Status Doc Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update active status docs so they reflect that the minimal GitHub Actions CI gate is now live and passing.

**Architecture:** Keep this as a narrow documentation-only change. Touch only the two outward-facing status documents that currently still describe CI as pending, and correct those statements without expanding scope into broader roadmap or test coverage rewrites.

**Why this is intentionally narrow (read before implementing):**

- **Only two files may change: `ROADMAP.md` and `KNOWN_ISSUES.md`.** No source, no workflow, no `README.md`, no `docs/tasks/**`, no `docs/archive/**`. If you feel tempted to "also fix" adjacent wording, stop — that is scope creep and will fail review.
- **"最小 CI 已接入" is NOT "测试体系完整".** The only thing that changed is: a minimal GitHub Actions gate now runs `npm test` / `npm run typecheck` / `npm run build` on `push`/`pull_request` to `main`. Coverage did not grow. Every remaining test gap that was true before CI is still true after CI and must remain listed verbatim in intent: migration 升级路径、renderer 组件、Electron 端到端、知识地图导入（`knowledgeMapService`）、study supervisor。
- **Correct only statements that are now false.** A line is in scope only if the arrival of CI made it untrue (i.e. it says CI is pending / 待接 CI / 未接入 CI). Any line describing something still true is out of scope even if it sits next to an edited line.

**Tech Stack:** Markdown, existing repository docs, current GitHub Actions CI status

## Global Constraints

- Modify only `ROADMAP.md` and `KNOWN_ISSUES.md`.
- Do not change `README.md`, test plans, or archived docs in this task.
- Preserve the existing document structure; make the smallest accurate wording changes.
- Update only statements that are now false because minimal CI is live.
- Do not overstate coverage: CI currently runs `npm test`, `npm run typecheck`, and `npm run build` only.

---

## Background

The repository now has an active GitHub Actions workflow at `.github/workflows/ci.yml`, and the first run on `main` succeeded. However, the public status docs still say the project is "待接 CI", which is no longer accurate.

**Exact stale anchors (as of this plan; re-confirm before editing since line numbers drift):**

- `ROADMAP.md` — the "最小测试体系" bullet under the stabilization priorities still ends with `🔧 待接 CI 作为提交门槛…`.
- `KNOWN_ISSUES.md` — the testing section, currently three touch points:
  - the section heading `### 测试体系（最小回归套件已落地，待接 CI）`
  - the "剩余缺口" line, which opens with `未接入 CI（提交门槛未强制）；…`
  - the closing `- 状态：最小回归套件已落地，待接 CI 并继续扩展。`

These are the only known false-because-of-CI statements. If a search turns up no other "待接 CI / 未接入 CI" occurrences, do not invent more.

## Non-Goals

- No new CI features or workflow changes.
- No README refresh.
- No rewrite of testing strategy docs.
- No edits to archived or historical documents.

## Scope

### In Scope

- `ROADMAP.md`
- `KNOWN_ISSUES.md`

### Out of Scope

- `README.md`
- `../tasks/2026-06-27-minimal-test-system.md`
- `docs/archive/**`
- `.github/workflows/ci.yml`

## Proposed Approach

1. Find the exact stale CI phrases in `ROADMAP.md` and `KNOWN_ISSUES.md`.
2. Replace "待接 CI" style wording with accurate current-state wording.
3. Keep the remaining gaps intact: migration coverage, renderer tests, Electron E2E, knowledge map import, and study supervisor coverage should still be listed if they remain true.

## Risks

- Easy to over-correct and imply the test system is complete when only the minimal CI gate is live.
- Easy to touch adjacent wording and accidentally broaden the doc diff.

## Acceptance Criteria

- `ROADMAP.md` no longer says CI is pending if it refers to the new minimal gate.
- `KNOWN_ISSUES.md` no longer says CI is pending if it refers to the new minimal gate.
- Both files still accurately describe remaining testing gaps.
- No other files are changed.

## Task Breakdown

### Task 1: Update CI status wording in active docs

**Files:**
- Modify: `ROADMAP.md`
- Modify: `KNOWN_ISSUES.md`

**Interfaces:**
- Consumes: current GitHub Actions workflow scope and latest successful run on `main`
- Produces: accurate outward-facing project status docs

- [ ] **Step 1: Locate stale CI wording**

Run a scoped search in only the two in-scope files and confirm the anchors from Background:

```bash
grep -nE "待接 CI|未接入 CI|GitHub Actions|CI" ROADMAP.md KNOWN_ISSUES.md
```

Expected hits: one line in `ROADMAP.md` (最小测试体系 bullet) and three in `KNOWN_ISSUES.md` (heading, 剩余缺口 line, 状态 line). Do not search or edit any other file.

- [ ] **Step 2: Rewrite only the false CI status lines**

Make the smallest edits that flip "待接 CI" to "CI 已接入" while leaving every true remaining-gap phrase intact.

`ROADMAP.md` — change the trailing status of the 最小测试体系 bullet only. Illustrative before/after (keep the coverage list and the migration/knowledge-map gap wording that already exists):

```text
before: …；🔧 待接 CI 作为提交门槛，并补 migration 升级路径与知识地图导入覆盖。
after:  …；✅ 最小 CI 已接入（GitHub Actions 在 push/PR 到 main 上运行 test/typecheck/build）作为提交门槛；🔧 仍需补 migration 升级路径与知识地图导入覆盖。
```

`KNOWN_ISSUES.md` — three edits, no more:

```text
heading before: ### 测试体系（最小回归套件已落地，待接 CI）
heading after:  ### 测试体系（最小回归套件已落地，最小 CI 已接入）

剩余缺口 before: - 剩余缺口：未接入 CI（提交门槛未强制）；未覆盖数据库 migration 升级路径…
剩余缺口 after:  - 剩余缺口：未覆盖数据库 migration 升级路径…   (删除 "未接入 CI（提交门槛未强制）；" 一项，其余缺口原样保留)

状态 before: - 状态：最小回归套件已落地，待接 CI 并继续扩展。
状态 after:  - 状态：最小回归套件已落地，最小 CI 已接入，仍需继续扩展覆盖面。
```

Constraints on wording:
- The exact final phrasing is the implementer's choice, but it MUST NOT imply the test system is complete. Keep the "继续扩展 / 仍需补" qualifier.
- The remaining-gap phrases below must survive unchanged in meaning:

```text
未覆盖数据库 migration 升级路径（当前仅验证全新初始化）
未覆盖 renderer 组件与 Electron 端到端
知识地图导入（knowledgeMapService）与 study supervisor 尚未纳入
```

- Do not touch the `npm test` coverage list, the 约 31 个用例 count, or the task-ledger link in `KNOWN_ISSUES.md`.

- [ ] **Step 3: Verify the docs do not overclaim**

Confirm the new wording still matches the *actual* CI scope — CI runs exactly these three, nothing more:

```text
npm test
npm run typecheck
npm run build
```

Reject your own edit if it says or implies: coverage increased, migration/renderer/E2E now tested, or "测试问题已解决 / 测试体系完整".

- [ ] **Step 4: Run minimal verification**

Confirm the diff is limited to CI-status wording in exactly the two target files, and that nothing else changed:

```bash
git diff -- ROADMAP.md KNOWN_ISSUES.md
git status --porcelain
```

Expected:

```text
only CI status wording updates in ROADMAP.md and KNOWN_ISSUES.md
git status shows no other modified tracked files (aside from this plan doc)
```

If `git status` shows any other changed file, revert it — this task changes only the two status docs.

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md KNOWN_ISSUES.md
git commit -m "docs: sync CI status"
```

## Verification

- Confirm `.github/workflows/ci.yml` exists and the latest `main` run succeeded.
- Confirm `git diff -- ROADMAP.md KNOWN_ISSUES.md` stays narrow.
- Confirm no other files changed in this task.
