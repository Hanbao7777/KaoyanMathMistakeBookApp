# Minimal GitHub CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal GitHub Actions CI gate that validates install, tests, typecheck, and production build on pushes and pull requests to `main`.

**Architecture:** Use one GitHub Actions workflow under `.github/workflows/ci.yml` with a single `ubuntu-latest` job. Keep the pipeline intentionally narrow so it reflects the current local acceptance bar and avoids mixing release packaging, matrix builds, or platform-specific publishing.

**Why this shape (read before implementing):**

- **Single Linux job, not a matrix.** The goal is a *merge gate* that mirrors the one local contract (`npm test` / `npm run typecheck` / `npm run build`), not cross-platform confidence. `ubuntu-latest` is the cheapest, fastest runner and the checks are platform-neutral (sql.js is WASM; tests run on built `dist/main/`). A Node-version or OS matrix multiplies runtime and maintenance for confidence the project does not need yet.
- **No `pack:win` in CI.** Packaging (`electron-builder --win portable`) is a Windows-target release step, is slow, and is not part of the local pass/fail bar. It belongs to a future release pipeline, not this gate.
- **No release / publish / artifact upload.** There is no release automation to gate here; adding it would expand scope beyond "does this change still build and pass tests."
- **No caching optimization or security scanning.** `actions/setup-node` built-in npm cache (`cache: npm`) is the only caching used because it is one line and free; anything beyond that (custom cache keys, `npm audit`, CodeQL) is out of scope for a first minimal gate.

**Tech Stack:** GitHub Actions, Node.js, npm, existing `npm test`, `npm run typecheck`, `npm run build`

## Global Constraints

- Do not add release, packaging, or artifact upload steps in this plan.
- Do not add a job matrix; use one Linux job only.
- Use `npm ci`, not `npm install`, in CI.
- CI must run the same quality gates already used locally: `npm test`, `npm run typecheck`, `npm run build`.
- Keep documentation changes minimal and only where needed to reflect the new CI gate.
- Preserve the repository's skeleton-first workflow: document review passes before implementation starts.
- Pin one Node major version in `setup-node`. `package.json` has no `engines` field, so pick a current LTS-class major (Node 22) that satisfies the toolchain (`node:test`, TypeScript 5.7, Vite 6, Electron 38 devDeps). Do not add an `engines` field to `package.json` as part of this plan — that is a source change and out of scope.

---

## Background

The repository now has a working minimal regression suite and stable local validation flow:

- `npm test`
- `npm run typecheck`
- `npm run build`

These checks pass locally, but there is no GitHub-hosted CI gate yet. Since the user usually uploads changes to GitHub, the next sensible stabilization step is to make that same minimal gate run automatically on `push` and `pull_request`.

## Non-Goals

- No Windows packaging in CI.
- No release drafting or auto-publish.
- No dependency audit or security scanner in this iteration.
- No test sharding, caching optimization, or matrix expansion unless needed later.
- No refactor of the current test harness.

## Scope

### In Scope

- Add `.github/workflows/ci.yml`.
- Trigger on `push` and `pull_request` for `main`.
- Install Node dependencies with `npm ci`.
- Run tests, typecheck, and build in that order.
- Optionally, and only if a doc currently makes a stale/false CI claim, apply one minimal doc correction (see conditional Task 2).

### Out of Scope

- Branch protection settings in GitHub UI.
- Required check naming policy.
- PR templates or contribution guide expansion.
- Any app/runtime code changes.

## Proposed Approach

### Approach A — Minimal single workflow (recommended)

One workflow, one Linux job, one Node version, sequential checks. Lowest maintenance cost and matches the current local contract exactly.

### Approach B — Matrix by Node version

Adds confidence across Node versions, but increases runtime and maintenance. Not justified until the baseline CI gate proves useful.

### Approach C — Split workflows by concern

Separate test/typecheck/build workflows. Better isolation, but adds overhead and fragments signal for a repo that only needs a basic merge gate right now.

**Recommendation:** Approach A. It is the smallest useful CI gate and fits the current stabilization phase.

## Risks

- CI may surface Linux-specific path or dependency assumptions that do not appear in the current local environment.
- `npm ci` may expose lockfile drift if future local installs are not kept clean.
- The existing large renderer chunk warning will still appear during build; it should remain non-blocking unless build behavior changes.

## Acceptance Criteria

- A workflow file exists at `.github/workflows/ci.yml`.
- The workflow triggers on `push` and `pull_request` targeting `main`.
- The workflow uses a Linux runner and installs dependencies with `npm ci`.
- The workflow runs `npm test`, `npm run typecheck`, and `npm run build`.
- No unrelated release or packaging logic is introduced.
- Any added documentation accurately describes the CI gate without overstating coverage. Documentation changes are optional: making no doc change is a valid, acceptable outcome.

## Task Breakdown

### Task 1: Define the CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Review: `package.json`

**Interfaces:**
- Consumes: existing npm scripts `test`, `typecheck`, `build`
- Produces: GitHub Actions workflow named CI or equivalent visible status check

- [ ] **Step 1: Confirm the exact scripts to run**

Open `package.json` and confirm the three gate scripts exist. They currently are:

```json
{
  "scripts": {
    "test": "npm run build:main && node --test tests/**/*.test.cjs",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.main.json --noEmit",
    "build": "tsc -p tsconfig.main.json && vite build --configLoader native"
  }
}
```

Notes for the implementer:
- `npm test` already runs `build:main` internally, so tests execute against freshly built `dist/main/`.
- `npm run build` runs both the main-process `tsc` and the Vite renderer build.
- Do not modify these scripts; the workflow only invokes them as-is.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/ci.yml` (create the `.github/workflows/` directory if it does not exist). Use exactly this single-job structure; the step order (`test` → `typecheck` → `build`) mirrors the local gate and lets tests fail fast:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Run typecheck
        run: npm run typecheck

      - name: Run build
        run: npm run build
```

Requirements this file must satisfy:
- Triggers only on `push` and `pull_request` to `main`.
- One job, one `ubuntu-latest` runner, one Node major (`22`).
- `npm ci` (not `npm install`) so the lockfile is authoritative.
- `cache: npm` is the only caching; add nothing else.
- No `env:` secrets, no `permissions:` escalation, no extra jobs.

- [ ] **Step 3: Self-check workflow scope**

Verify the workflow does not add:

```text
pack:win
release upload
matrix strategy
artifact upload
security scan
```

- [ ] **Step 4: Verify local commands still match CI**

Run the same three commands the workflow runs, in the same order:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

```text
tests pass
typecheck passes
build passes
```

Caveats to expect (non-blocking):
- On a clean Linux install, `npm ci` may need Rollup's Linux optional dependency (e.g. `@rollup/rollup-linux-x64-gnu`); `npm ci` from the committed lockfile should resolve it. This is already noted in `KNOWN_ISSUES.md`.
- `vite build` emits a large-renderer-chunk warning; it is a warning, not a failure, and must not be treated as a gate failure.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add minimal GitHub Actions gate"
```

### Task 2 (CONDITIONAL): Sync minimal docs only if a real gap exists

> **Condition gate — read first.** This task is *not* required for the CI gate to work. Do it **only if** Step 1 below finds that the docs are actively misleading (e.g. `KNOWN_ISSUES.md` still says there is no CI, or a doc claims coverage the workflow does not provide). If the docs are merely silent about CI, **make no change and skip to closing Task 1** — do not add doc copy for its own sake. Default outcome of this task is "no change".

**Files (only if the condition is met):**
- Modify: `KNOWN_ISSUES.md` (primary — it already tracks the "待接 CI" gap)
- Modify: `README.md` (only if a contributor-facing CI note reduces real ambiguity)

**Interfaces:**
- Consumes: final workflow behavior from Task 1
- Produces: concise CI documentation that matches the implemented gate

- [ ] **Step 1: Check whether docs already mention CI, and whether any statement is now wrong**

Search for GitHub Actions / CI references in:

```text
README.md
KNOWN_ISSUES.md
```

Decision:
- If a doc makes a claim that is now false (e.g. "待接 CI" / "no CI gate"), it qualifies for a minimal correction.
- If the docs simply do not mention CI, that is acceptable — stop here and change nothing.

- [ ] **Step 2: Add only minimal doc updates if Step 1 found a false/stale claim**

Keep it to one line that matches the actual workflow. Example:

```md
- GitHub Actions CI runs `npm test`, `npm run typecheck`, and `npm run build` on pushes and pull requests to `main`.
```

Do not restructure sections, expand the roadmap, or edit `package.json`. If `KNOWN_ISSUES.md` says "待接 CI", the minimal fix is to update that single status, not to rewrite the section.

- [ ] **Step 3: Re-run validation only if docs changed together with the workflow**

If (and only if) Step 2 changed a doc, confirm the local baseline is unaffected:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

```text
same passing baseline as before
```

- [ ] **Step 4: Commit (only if a doc actually changed)**

```bash
git add README.md KNOWN_ISSUES.md
git commit -m "docs: note minimal CI gate"
```

If Task 2's condition was not met, there is nothing to commit here — the workflow commit from Task 1 is the only artifact of this plan.

## Verification

- Local verification:

```bash
npm test
npm run typecheck
npm run build
```

- Review verification:
  - Confirm `.github/workflows/ci.yml` is limited to the intended merge gate.
  - Confirm no packaging or release work was mixed in.
  - Confirm any doc copy matches actual workflow behavior.
