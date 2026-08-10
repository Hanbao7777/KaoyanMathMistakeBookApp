# Worktree Change Triage Checklist

Date: 2026-06-27

## Goal

Classify the current dirty worktree into reviewable groups, separate real logic changes from line-ending noise, and define the next execution tasks for CCB agents.

## Current Baseline

- Branch: `main`, ahead of `origin/main` by 112 commits.
- Plain diff size: 33 tracked files, about `+18684 / -18223`.
- Diff after ignoring CRLF/LF-only changes: 10 tracked files, about `+1910 / -1449`.
- Main finding: most of the scary diff is line-ending normalization noise, not logic change.

## Real Logic Change Set

These files still show meaningful changes with:

```bash
git diff --ignore-cr-at-eol
```

- `docs/superpowers/plans/2026-05-26-ticktick-integration.md`
- `docs/superpowers/plans/2026-06-02-考点汇总替换知识地图.md`
- `docs/superpowers/specs/2026-05-26-ticktick-integration-design.md`
- `docs/superpowers/specs/2026-06-02-考点汇总替换知识地图-design.md`
- `src/main/ipc/registerIpc.ts`
- `src/preload/preload.ts`
- `src/renderer/App.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- `src/renderer/styles/ticktick.css`
- `src/shared/api.ts`

## Group A: Governance Documents

Status: keep.

- `AGENTS.md`
- `.ccb/collaboration_protocol.md`
- `docs/design/2026-06-27-project-assessment-and-roadmap.md`
- `2026-06-27-worktree-change-triage.md`

Acceptance:

- Documents are in category-appropriate locations.
- No runtime/session files are mixed into the document set.
- The documents describe process and project state without claiming unverified features are complete.

## Group B: Active Design And Plan Documents

Status: keep, but classify as active plan/backlog rather than implemented behavior.

- `docs/superpowers/plans/2026-05-26-ticktick-integration.md`
- `docs/superpowers/specs/2026-05-26-ticktick-integration-design.md`
- `docs/superpowers/plans/2026-06-02-考点汇总替换知识地图.md`
- `docs/superpowers/specs/2026-06-02-考点汇总替换知识地图-design.md`
- `TICKTICK_FEATURES.md`
- `TICKTICK_KNOWN_BUGS.md`

Acceptance:

- TickTick documents distinguish implemented, broken, beta, and planned behavior.
- The exam-point replacement documents are not presented as already implemented.
- Long-term plan: merge or link these from `README.md`, `ROADMAP.md`, and `KNOWN_ISSUES.md`; archive superseded copies later.

## Group C: Widget And TickTick Logic

Status: verify before accepting.

- `src/main/ipc/registerIpc.ts`
- `src/preload/preload.ts`
- `src/shared/api.ts`
- `src/renderer/App.tsx`
- `src/renderer/pages/ticktick/DesktopWidget.tsx`
- `src/renderer/styles/ticktick.css`

Primary risks:

- Widget window open/close, bounds, resize, pin state, and main-window focus may regress.
- Preload/API/IPC methods must stay aligned.
- TickTick CSS may affect either TickTick layout or the mistake-book layout.
- Desktop widget quick-add must not create invalid tasks.

Required verification:

- `npm run typecheck`
- `npm run build` after dependency issue is fixed
- Manual Electron check for widget open, close, resize, drag, pin, position persistence, and main-window focus
- Manual TickTick layout check for Today, Calendar, Focus, Settings, and main mistake-book mode

## Group D: Line-Ending Noise

Status: decide before committing.

These files appear large in plain `git diff`, but have no logic diff under `--ignore-cr-at-eol`.

Examples:

- `src/main/database/schema.ts`
- `src/main/services/databaseService.ts`
- `src/main/services/knowledgeMapService.ts`
- `src/main/services/backupService.ts`
- `src/main/services/pdfExportService.ts`
- `src/main/services/structuredImportService.ts`
- `src/renderer/styles/global.css`
- `src/renderer/pages/KnowledgeMapPage.tsx`
- `src/renderer/pages/ReviewPage.tsx`
- `src/renderer/pages/ImportPage.tsx`
- `src/shared/types.ts`

Recommended handling:

1. Add or confirm line-ending policy through `.gitattributes`.
2. If choosing to normalize, commit line-ending-only changes separately.
3. If not choosing to normalize now, avoid mixing these files with logic commits.

Acceptance:

- Reviewers can reproduce that these files have no logic change with `git diff --ignore-cr-at-eol`.
- Line-ending-only changes are never mixed with widget, IPC, or data-layer behavior changes.

## Group E: Runtime And Archive Candidates

Status: separate from product changes.

- `.superpowers/brainstorm/*`
- `.ccb/.claude-claude-session`
- `.ccb/.codex-codex-session`
- `.ccb/.opencode-opencode-session`
- `.ccb/runtime/*`
- `tishici/*.md`

Recommended handling:

- Runtime/session files should not be part of product commits unless the team explicitly decides otherwise.
- `tishici/*.md` should be reviewed as historical/process documentation and moved under `docs/archive/` if still useful.
- Do not delete these blindly; classify first.

## Immediate Execution Tasks

### Task 1: Build And Dependency Stabilization

Owner: `opencode`

Scope:

- Investigate why `npm run build` fails with missing `@rollup/rollup-linux-x64-gnu`.
- Propose the minimal fix.
- Verify `npm run typecheck`.
- Verify `npm run build` if dependency repair is possible.

Expected output:

- Root cause
- Files changed, if any
- Verification result
- Remaining blocker, if build still fails

### Task 2: Widget/TickTick Change Verification

Owner: `opencode`

Scope:

- Review the real logic changes in `registerIpc.ts`, `preload.ts`, `api.ts`, `App.tsx`, `DesktopWidget.tsx`, and `ticktick.css`.
- Identify correctness risks before implementation proceeds.
- Do not refactor broadly.

Expected output:

- Findings with file references
- Required fixes before acceptance
- Manual verification checklist

### Task 3: Documentation Consistency

Owner: `claude`

Scope:

- Review `README.md`, `ROADMAP.md`, `KNOWN_ISSUES.md`, `TICKTICK_FEATURES.md`, `TICKTICK_KNOWN_BUGS.md`, and the active docs under `docs/superpowers/`.
- Recommend a document structure that reflects actual implemented, beta, broken, and planned functionality.
- Do not delete documents.

Expected output:

- Which docs should remain primary
- Which docs should be merged
- Which docs should be archived
- Exact documentation inconsistencies to fix

### Task 4: Line-Ending Policy Recommendation

Owner: `claude`

Scope:

- Inspect existing `.gitattributes`, `.editorconfig`, and `.gitignore` if present.
- Recommend whether to normalize line endings now or defer.
- Provide a concrete, low-risk policy.

Expected output:

- Recommended policy
- Files/config changes needed
- Whether to keep or separate the current line-ending-only diff

## Next Controller Decision

After Tasks 1-4 return:

1. Accept or reject the dependency/build fix.
2. Decide whether widget/TickTick changes can be kept as-is or need repair.
3. Decide documentation consolidation order.
4. Decide line-ending strategy before any commit.

## Agent Results

### Task 1 Result: Build And Dependency Stabilization

Owner: `opencode`

Status: `DONE_WITH_CONCERNS`

Result:

- Root cause was a local `node_modules` optional dependency gap: Rollup expected `@rollup/rollup-linux-x64-gnu`, and the lockfile already contained it.
- Minimal repair was `npm install` from the existing lockfile.
- `package.json` and `package-lock.json` were not changed.
- `npm run typecheck` passed.
- `npm run build` passed.
- Remaining build concern: Vite reports the renderer main chunk is about 900 kB after minification.
- Remaining maintenance concern: `npm install` reports 14 audit vulnerabilities; this was not handled because it is outside the current stabilization scope.

Controller verification:

- Re-ran `npm run typecheck`: passed.
- Re-ran `npm run build`: passed.
- Verified `dist/`, `package.json`, and `package-lock.json` did not gain new tracked worktree changes from the build.

Decision:

- Accept the dependency repair as sufficient for current build stabilization.
- Track bundle-size and audit findings as follow-up debt, not blockers for this triage.

### Task 2 Result: Widget/TickTick Change Verification

Owner: `opencode`

Status: `DONE_WITH_CONCERNS`

Result:

- Static API alignment looks correct for widget additions:
  - `widget:setBounds`
  - `widget:openMain`
  - `widget:isOpen`
- Widget bounds and pin persistence look plausible.
- Desktop widget quick-add no longer appears to create orphan tasks when no TickTick list exists.
- Prior TickTick P0 layout issue appears addressed by using `ticktick-root` and full-height TickTick CSS containers.

Concerns:

- `focusMainWindow()` identifies the main window by title comparison against `Kaoyan Desktop Widget`; this is brittle if titles change.
- Widget timer/shared timer behavior still needs cross-window manual validation.
- Manual Electron verification was not performed.

Decision:

- Do not reject the widget/TickTick changes based on static review.
- Require manual Electron verification before product acceptance.

Manual verification:

- User manually verified the Widget/TickTick flow after build stabilization.
- Result: no issues found for now.

Decision update:

- Accept Widget/TickTick changes as currently validated.
- Keep the brittle `focusMainWindow()` window-title lookup and cross-window timer behavior as follow-up risks, not current blockers.

### Task 3 Result: Documentation Consistency

Owner: `claude`

Status: `DONE_WITH_CONCERNS`

Result:

- `README.md` is materially out of sync with implementation:
  - It says the app does not include OCR/AI, while the code includes OCR scripts, DeepSeek service, AI import, and AI diagnosis.
  - It does not describe TickTick despite an implemented TickTick mode and widget.
- `KNOWN_ISSUES.md` is stale and lacks TickTick, build, line-ending, and `ELECTRON_RUN_AS_NODE` issues.
- `ROADMAP.md` still lists V1.1/V1.2 as planned even though large portions are implemented.
- `TICKTICK_FEATURES.md` and `TICKTICK_KNOWN_BUGS.md` should not remain long-term root-level standalone documents.

Recommended document roles:

- `README.md`: project overview and true current capability summary.
- `ROADMAP.md`: public roadmap, with implemented/beta/planned status clearly separated.
- `KNOWN_ISSUES.md`: single known-issues entry point.
- `docs/design/2026-06-27-project-assessment-and-roadmap.md`: current detailed state document.
- `docs/superpowers/plans/` and `docs/superpowers/specs/`: active implementation plans/specs only.

Decision:

- Accept the recommendation.
- Next documentation task should update README/ROADMAP/KNOWN_ISSUES first, then merge/archive TickTick standalone docs later.

### Task 4 Result: Line-Ending Policy Recommendation

Owner: `claude`

Status: `DONE_WITH_CONCERNS`

Result:

- `.gitattributes` does not exist.
- `.editorconfig` does not exist.
- `.gitignore` exists.
- 23 tracked files appear to be pure CRLF/LF conversion noise with no logic diff under `git diff --ignore-cr-at-eol`.

Recommended policy:

```gitattributes
* text=auto eol=lf
*.cmd text eol=crlf
```

Recommended order:

1. Add `.gitattributes`.
2. Keep real logic changes separate from line-ending-only changes.
3. If normalizing, do it later in a dedicated commit with `git add --renormalize .`.

Decision:

- Accept the policy recommendation.
- Do not run full renormalization until the current real logic changes are reviewed and separated.

Controller action:

- Added `.gitattributes` with LF as the default text line ending and CRLF preserved for `*.cmd`.
- Did not run `git add --renormalize .`.

Follow-up dispatch:

- Sent `claude` a focused documentation update task for `README.md`, `ROADMAP.md`, and `KNOWN_ISSUES.md`.
- Job: `job_717715a9c1ff`

### Task 5: Documentation Archive Plan

Owner: `claude`

Scope:

- Prepare a concrete archive plan for `TICKTICK_FEATURES.md`, `TICKTICK_KNOWN_BUGS.md`, and `tishici/*.md`.
- Do not delete documents.
- If moving files is clearly safe, move process/history reports under `docs/archive/` with descriptive names.
- Keep `README.md`, `ROADMAP.md`, and `KNOWN_ISSUES.md` as the primary entry points.

Expected output:

- Files moved or left in place
- Archive locations
- Remaining primary links
- Self-review

### Task 6: Commit Grouping And Line-Ending Execution Plan

Owner: `opencode`

Scope:

- Based on current `git status`, propose concrete commit groups.
- Separate:
  - governance docs
  - main docs
  - Widget/TickTick logic
  - active superpowers plans/specs
  - line-ending policy
  - runtime/archive candidates
- Verify whether `.gitattributes` has already suppressed the CRLF/LF noise in `git status`.
- Do not commit.
- Do not run `git add --renormalize .`.

Expected output:

- Recommended commit groups
- Exact files per group
- Whether any group is still too risky to commit
- Remaining verification before commit

## Follow-Up Agent Results

### Task 5 Result: Documentation Archive Plan

Owner: `claude`

Status: `DONE`

Result:

- Moved historical process documents from `tishici/` to `docs/archive/tishici/`.
- Left `TICKTICK_FEATURES.md` and `TICKTICK_KNOWN_BUGS.md` in place because current primary docs still link to them.
- Did not modify source code.

Archived files:

- `docs/archive/tishici/Claude-Code开发报告-TickTick集成.md`
- `docs/archive/tishici/Codex-20260529-exe白屏根因排查报告.md`
- `docs/archive/tishici/Phase3-完整改动汇报-ClaudeCode.md`
- `docs/archive/tishici/Phase3-审查报告-资料进度+建议节奏.md`
- `docs/archive/tishici/考点汇总.txt`

Decision:

- Accept the archive move.
- Keep `TICKTICK_FEATURES.md` and `TICKTICK_KNOWN_BUGS.md` at the repository root until current links are replaced or V1.3 TickTick stabilization is complete.

### Task 6 Result: Commit Grouping And Line-Ending Execution Plan

Owner: `opencode`

Status: `DONE`

Result:

- Confirmed `.gitattributes` exists and CRLF/LF noise no longer appears in `git status`.
- Confirmed no commit, no staging, no `git add --renormalize .`, and no source edits were performed.
- Proposed commit groups for line-ending policy, governance docs, public docs, active plans/specs, Widget/TickTick logic, runtime artifacts, historical materials, and test helper.

Controller corrections:

- Do not include `.ccb/ccb_memory.md` in the governance/process docs commit by default. It is CCB-generated project memory and should be treated as runtime/generated coordination state unless the user explicitly wants it versioned.
- Do include `.ccb/collaboration_protocol.md` if committing repository collaboration rules, because it is an intentional project protocol document created in this session.
- Keep `.ccb/.claude-claude-session`, `.ccb/.codex-codex-session`, `.ccb/.opencode-opencode-session`, `.ccb/runtime-root-ref.json`, and `.ccb/runtime/*` out of product commits.

Accepted commit grouping:

1. Line-ending policy:
   - `.gitattributes`

2. Collaboration/governance docs:
   - `AGENTS.md`
   - `.ccb/collaboration_protocol.md`
   - `docs/design/2026-06-27-project-assessment-and-roadmap.md`
   - `2026-06-27-worktree-change-triage.md`

3. Public docs consistency:
   - `README.md`
   - `ROADMAP.md`
   - `KNOWN_ISSUES.md`

4. Active design/plan docs:
   - `docs/superpowers/plans/2026-05-26-ticktick-integration.md`
   - `docs/superpowers/specs/2026-05-26-ticktick-integration-design.md`
   - `docs/superpowers/plans/2026-06-02-考点汇总替换知识地图.md`
   - `docs/superpowers/specs/2026-06-02-考点汇总替换知识地图-design.md`
   - `TICKTICK_FEATURES.md`
   - `TICKTICK_KNOWN_BUGS.md`

5. Widget/TickTick logic:
   - `src/main/ipc/registerIpc.ts`
   - `src/preload/preload.ts`
   - `src/shared/api.ts`
   - `src/renderer/App.tsx`
   - `src/renderer/pages/ticktick/DesktopWidget.tsx`
   - `src/renderer/styles/ticktick.css`

6. Historical archive:
   - `docs/archive/tishici/Claude-Code开发报告-TickTick集成.md`
   - `docs/archive/tishici/Codex-20260529-exe白屏根因排查报告.md`
   - `docs/archive/tishici/Phase3-完整改动汇报-ClaudeCode.md`
   - `docs/archive/tishici/Phase3-审查报告-资料进度+建议节奏.md`
   - `docs/archive/tishici/考点汇总.txt`

7. Optional test helper:
   - `test-electron-start.js`

Excluded from product commits unless explicitly requested:

- `.ccb/ccb_memory.md`
- `.ccb/.claude-claude-session`
- `.ccb/.codex-codex-session`
- `.ccb/.opencode-opencode-session`
- `.ccb/runtime-root-ref.json`
- `.ccb/runtime/*`
- `.superpowers/brainstorm/*`
