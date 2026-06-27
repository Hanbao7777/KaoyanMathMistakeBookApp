# AGENTS.md

## Project Collaboration

This repository uses CCB for visible multi-agent collaboration.

- Use CCB `ask` for project-level collaboration with configured agents.
- Delegate with the goal, scope/files, assumptions, expected output, and verification needs.
- Reply concisely with findings, changes, verification, blockers, and risks when relevant.

## Default Agent Roles

- `codex`: controller. Owns task intake, decomposition, design/task skeletons, dispatch, review decisions, and final acceptance.
- `claude`: preferred for lightweight tasks such as document expansion, copy cleanup, small UI/style changes, simple refactors, and straightforward test additions.
- `opencode`: preferred for complex tasks such as multi-file implementation, architecture-sensitive changes, complex debugging, data-flow changes, and higher-risk refactors.

## Execution Protocol

1. `codex` reads local context first and minimizes task scope before delegating.
2. `codex` creates plan or document skeletons before expansion work when useful.
3. `codex` delegates one task at a time with minimal sufficient context.
4. The implementer agent completes the task and performs self-review before handoff.
5. `codex` reviews for spec compliance first.
6. `codex` reviews for code quality and regression risk second.
7. If either review fails, the task is returned to the implementer with concrete fixes required.
8. Only tasks that pass both review stages are accepted as complete.

## Routing Rules

- Use `claude` for narrow, mechanical, or documentation-heavy tasks.
- Use `opencode` for cross-file, integration-heavy, or higher-risk tasks.
- If `claude` fails the same task twice, escalate the task to `opencode`.

## Required Subagent Handoff Format

Every delegated task should return:

- `Goal`
- `Files Changed`
- `Key Changes`
- `Verification`
- `Risks / Limitations`
- `Self-Review`
- `Status`

`Status` must be one of:

- `DONE`
- `DONE_WITH_CONCERNS`
- `NEEDS_CONTEXT`
- `BLOCKED`

## Required Self-Review

Before handoff, the implementer must verify:

- The requested scope was followed.
- Acceptance criteria were satisfied.
- Relevant tests, build steps, or manual verification were run where applicable.
- No unjustified extra behavior was introduced.
- Risks, assumptions, and incomplete items are explicitly listed.

## Review Gates

### Gate 1: Spec Compliance

Reject and return the task if:

- Requested behavior is incomplete.
- Acceptance criteria are unmet.
- The implementation exceeds scope without justification.
- Required docs or task artifacts are missing.
- Verification is missing or clearly insufficient.

### Gate 2: Code Quality

Reject and return the task if:

- There is a clear regression risk.
- The implementation is unnecessarily hard to maintain.
- Obvious edge cases are unhandled.
- File boundaries or naming are materially inconsistent with the codebase.
- Important review findings remain unresolved.

## Plan and Document Skeleton Standard

When creating a design doc skeleton, task doc skeleton, or implementation plan, include at minimum:

- Background
- Goal
- Non-Goals
- Scope
- Constraints
- Proposed Approach
- Risks
- Acceptance Criteria
- Task Breakdown
- Verification

## Documentation Organization

- All newly created documents must be placed into a clear category-specific location instead of being dropped into the repository root arbitrarily.
- Prefer stable directory grouping by document purpose, for example:
  - `docs/superpowers/plans/` for implementation plans
  - `docs/design/` for design and architecture notes
  - `docs/tasks/` for task breakdowns and execution checklists
  - `docs/archive/` for outdated or superseded documents
- If a document is replaced, outdated, or no longer authoritative, move it to an archive location instead of leaving it mixed with active documents.
- When archiving a document, preserve enough naming context to show what it was and when it became obsolete.
- Active documents should be easy to distinguish from archived documents at a glance.

For multi-step implementation plans, prefer:

- `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

## Efficiency Rules

- Read only the files needed for the current task.
- Delegate with minimal sufficient context instead of broad repository dumps.
- Prefer skeleton-first, expansion-second for documentation work.
- Keep reviews focused on correctness, regression risk, and acceptance.
- Avoid unnecessary back-and-forth when direct execution is possible.

## CCB Runtime Rules

- CCB `ask` is submit-only: submit once, then stop unless diagnostics were explicitly requested.
- During an active CCB ask task, use `ask --callback` when a child result is needed to finish; use `ask --silence` only for independent no-result-needed work.
- During a CCB callback continuation, answer directly with the final result; do not use `ask`, `--callback`, or `--silence` to send that final result to the original caller.

## Operating Default

Unless explicitly overridden by the user:

- `codex` orchestrates and performs final review
- `claude` handles lighter execution
- `opencode` handles heavier execution
- self-review is mandatory before handoff
- `codex` review is mandatory before acceptance
