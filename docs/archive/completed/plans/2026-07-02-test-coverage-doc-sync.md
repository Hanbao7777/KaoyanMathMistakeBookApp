# Test Coverage Doc Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update active documentation so it accurately reflects the current automated test coverage after the recent migration, knowledge-map import, and study-supervisor additions.

**Architecture:** Keep this as a narrow documentation-only change. Touch only the active status/task documents that currently underreport the real test coverage, and correct those statements without widening into broader roadmap or feature rewrites.

**Why this is intentionally narrow (read before implementing):**

- This round ONLY syncs test-coverage *status* wording. No new tests, no CI changes, no feature/roadmap reprioritization.
- **"覆盖面提升" is NOT "测试体系完整".** Three areas moved from uncovered → covered (migration upgrade, knowledge-map import, study-supervisor loop). That does not mean testing is done: **renderer component tests and Electron end-to-end remain genuinely uncovered** and must stay listed as open gaps. Do not delete the remaining-gap wording; only remove the three now-false items.
- Correct only statements that recent test additions made false. A line describing something still true (renderer/E2E gaps, the `npm test` entrypoint) is out of scope even if adjacent to an edited line.

**Tech Stack:** Markdown, existing repository docs, current `npm test` coverage state

## Global Constraints

- Keep this task documentation-only.
- Prefer the smallest accurate wording changes.
- Do not expand scope into new test implementation, CI changes, or TickTick fixes.
- Preserve the current document structure where possible.
- Do not overclaim: renderer and Electron E2E are still uncovered.

---

## Background

The repository has recently added automated coverage for:

- migration upgrade regression (`tests/main/migrationUpgrade.test.cjs`)
- knowledge-map import (`tests/main/knowledgeMapImport.test.cjs`)
- study-supervisor supervision loop (`tests/main/studySupervisor.test.cjs`)

The current docs still describe some of those areas as uncovered, so the public/testing status is now stale.

**Current facts (as of this plan; re-confirm with the commands in Step 1 since counts drift):**

- `tests/` now holds **12 test files** — the three above plus: `ipc/ipc-contract-check.test.cjs`, `backupService`, `bridgeService`, `import`, `importBatchService`, `questionBankService`, `reviewAlgorithm`, `schema`, `ticktickService`.
- Total `test()` cases ≈ **41** (was "约 31" in the docs — that number is now understated but is a secondary correction; only update it if you touch the line it sits on).

**Known stale anchors (line numbers drift — locate by text, not number):**

- `KNOWN_ISSUES.md`, the "剩余缺口" bullet in the 测试体系 section, currently reads:
  `- 剩余缺口：未覆盖数据库 migration 升级路径（当前仅验证全新初始化）；未覆盖 renderer 组件与 Electron 端到端；知识地图导入（knowledgeMapService）与 study supervisor 尚未纳入。`
  Three claims here are now FALSE (migration, knowledge-map import, study supervisor). The renderer + Electron E2E claim is still TRUE and must remain.
- `ROADMAP.md`, the "最小测试体系" bullet, currently ends with `🔧 仍需补 migration 升级路径与知识地图导入覆盖。` — this is a directly-adjacent, now-false test-coverage claim, so it qualifies for correction under the conditional ROADMAP clause in Scope.
- `../tasks/2026-06-27-minimal-test-system.md` contains a batch note (around the structured-import section) saying knowledge-map import `未纳入本批次`. That was accurate as a *historical batch boundary* and is not necessarily false now; treat the ledger as append-only history — only add a short "后续已单独立项覆盖" note if it actively misleads, do not rewrite completed batch records.

## Non-Goals

- No new tests
- No README rewrite
- No feature roadmap reprioritization
- No archive or cleanup pass beyond the minimum needed status sync

## Scope

### In Scope

- `KNOWN_ISSUES.md` — the 测试体系 section's "剩余缺口" bullet (primary edit).
- `ROADMAP.md` — ONLY the trailing `🔧 仍需补 migration…知识地图导入覆盖` fragment of the 最小测试体系 bullet, which is now false. This is the "directly adjacent test-coverage claim" exception; do not touch any other ROADMAP line.

### Conditional / minimal-touch

- `../tasks/2026-06-27-minimal-test-system.md` — append-only history. Leave completed batch records as-is; add at most a one-line pointer only if a note actively misleads (see Background).

### Out of Scope

- `README.md`
- Any other `ROADMAP.md` line, or any code/workflow files.

## Proposed Approach

1. Find stale statements about uncovered test areas.
2. Update only the specific bullets/sections that are now false.
3. Keep the still-open gaps explicit: renderer components and Electron end-to-end remain uncovered.

## Risks

- Easy to over-correct and imply testing is “complete”.
- Easy to let this turn into a broad doc refresh instead of a narrow sync.

## Acceptance Criteria

- Active docs (`KNOWN_ISSUES.md`, and the one `ROADMAP.md` fragment) no longer say migration, knowledge-map import, or study-supervisor are uncovered.
- Renderer component and Electron end-to-end are still called out as open gaps in both edited files.
- No wording implies the test system is complete; a "仍需/剩余" qualifier remains.
- The task ledger's completed batch records are left intact (append-only).
- No code or workflow files are changed; the diff is limited to the edited docs.

## Task Breakdown

### Task 1: Sync active test-coverage status docs

**Files:**
- Modify: `KNOWN_ISSUES.md`
- Modify: `ROADMAP.md` (trailing test-coverage fragment only)
- Modify (conditional, append-only): `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes: current automated coverage in `tests/main/` and `tests/ipc/`
- Produces: accurate active documentation for current test coverage

- [ ] **Step 1: Locate stale coverage wording and confirm current facts**

Confirm what is actually covered and find the stale lines (locate by text; line numbers drift):

```bash
find tests -name '*.test.cjs' | sort
grep -nE "migration|knowledge|supervisor|知识地图|未覆盖|未纳入|剩余缺口" KNOWN_ISSUES.md ROADMAP.md
```

Verify `migrationUpgrade.test.cjs`, `knowledgeMapImport.test.cjs`, and `studySupervisor.test.cjs` all exist — those are the three areas whose "uncovered" claims are now false.

- [ ] **Step 2: Update only false coverage claims**

`KNOWN_ISSUES.md` — rewrite the "剩余缺口" bullet to drop the three now-covered items while keeping renderer/E2E. Illustrative before/after:

```text
before: - 剩余缺口：未覆盖数据库 migration 升级路径（当前仅验证全新初始化）；未覆盖 renderer 组件与 Electron 端到端；知识地图导入（knowledgeMapService）与 study supervisor 尚未纳入。
after:  - 剩余缺口：未覆盖 renderer 组件与 Electron 端到端（其余高风险链路含 migration 升级、知识地图导入、study supervisor 监督闭环已纳入回归）。
```

`ROADMAP.md` — trim only the false trailing fragment of the 最小测试体系 bullet:

```text
before: …作为提交门槛；🔧 仍需补 migration 升级路径与知识地图导入覆盖。
after:  …作为提交门槛；🔧 仍需补 renderer 组件与 Electron 端到端覆盖。
```

Optionally, if you are already editing the `KNOWN_ISSUES.md` coverage line, you may update the stale "约 31 个用例" count to the current ≈41; do not make a separate edit solely for the number.

- [ ] **Step 3: Preserve real remaining gaps**

Both files must still explicitly name the genuinely-open gaps:

```text
renderer component coverage
Electron end-to-end coverage
```

Do not imply testing is "complete" or "done" — keep a "仍需 / 剩余" qualifier in both files.

- [ ] **Step 4: Verify the diff stays narrow**

```bash
git diff -- KNOWN_ISSUES.md ROADMAP.md ../tasks/2026-06-27-minimal-test-system.md
git status --short
```

Expected:

```text
only test-coverage status wording updates in the edited files
git status shows no other modified tracked files (aside from this plan doc)
```

If any unrelated file or line changed, revert it.

- [ ] **Step 5: Commit**

```bash
git add KNOWN_ISSUES.md ROADMAP.md
git commit -m "docs: sync test coverage status"
```

Add `../tasks/2026-06-27-minimal-test-system.md` to the commit only if Step 2's conditional note was actually applied.

## Verification

- Confirm the updated docs match the current test files under `tests/main/` and `tests/ipc/`.
- Confirm no code files are touched.
