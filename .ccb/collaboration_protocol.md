# CCB Collaboration Protocol

## Roles

- `codex`: controller. Owns task intake, decomposition, plan/document skeletons, task dispatch, review decisions, and final acceptance.
- `claude`: preferred for lightweight work such as document expansion, copy cleanup, small UI/style changes, simple refactors, and straightforward test additions.
- `opencode`: preferred for complex work such as multi-file implementation, architecture-sensitive changes, complex debugging, data-flow changes, and higher-risk refactors.

## Default Workflow

1. `codex` reads local context and minimizes scope before delegating.
2. `codex` uses `superpowers:writing-plans` conventions when producing plan skeletons or task skeletons.
3. `codex` dispatches one task at a time through CCB `ask`, providing only the required context:
   - goal
   - exact scope/files
   - acceptance criteria
   - constraints
   - required verification
   - required self-review output
4. The implementer agent completes the task and performs self-review before handoff.
5. `codex` performs stage 1 review: spec and acceptance compliance.
6. If stage 1 passes, `codex` performs stage 2 review: code quality, regression risk, and verification quality.
7. If either review fails, the task is sent back to the same implementer with concrete correction requirements.
8. The task is accepted only when both review stages pass.

## Routing Rules

- Send to `claude` when the task is narrow, mechanical, or documentation-heavy.
- Send to `opencode` when the task spans multiple files, needs integration judgment, or carries meaningful regression risk.
- If `claude` fails the same task twice, escalate the task to `opencode`.
- `codex` should avoid spending tokens on long explanations when direct task execution or review is sufficient.

## Required Delivery Format For Subagents

Every delegated task must return:

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

## Required Self-Review Checklist

Before handoff, the implementer must verify:

- The task matches the requested scope.
- Acceptance criteria are satisfied.
- Related tests, build steps, or manual verification were run where applicable.
- No known extra behavior was added without justification.
- Risks, assumptions, and incomplete items are explicitly listed.

## Review Gate Rules

### Gate 1: Spec Compliance

Reject and return the task if any of the following is true:

- The requested behavior is incomplete.
- Acceptance criteria are unmet.
- The implementation exceeds scope without justification.
- Required docs or task artifacts are missing.
- Verification is missing or does not cover the change.

### Gate 2: Code Quality

Reject and return the task if any of the following is true:

- There is a clear regression risk.
- The change is harder to maintain than necessary.
- Obvious edge cases are unhandled.
- File boundaries or naming are materially inconsistent with the codebase.
- Important review findings remain unresolved.

## Plan and Document Skeleton Standard

When `codex` creates a design doc skeleton, task doc skeleton, or implementation plan, it should include at minimum:

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

## Documentation Classification And Archiving

- New documents must be stored in a category-appropriate location instead of being placed arbitrarily.
- Preferred default grouping:
  - `docs/superpowers/plans/` for implementation plans
  - `docs/design/` for design and architecture documents
  - `docs/tasks/` for task docs, execution notes, and checklists
  - `docs/archive/` for obsolete or superseded documents
- If a document is no longer current, it should be archived rather than left mixed with active documentation.
- Archive moves should preserve enough filename context to identify the original purpose and obsolescence timing.
- Active and archived documents should remain visually and structurally distinct.

For multi-step implementation plans, prefer saving under:

- `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

## Token Efficiency Rules

- Prefer reading only the files needed for the current task.
- Delegate with minimal sufficient context instead of broad repository dumps.
- Prefer skeleton-first, expansion-second for documentation work.
- Keep reviews focused on correctness, regression risk, and acceptance.
- Avoid repeated status chatter unless a blocker or review result changes the path.

## CCB Ask Usage

- Use CCB `ask` for project-level collaboration.
- `ask` is submit-only: submit once and do not poll unless diagnostics were explicitly requested.
- Provide goal, scope, assumptions, expected output, and verification needs in every delegation.
- In callback continuations, return the final result directly instead of re-dispatching.

## Operating Rule

Unless the user explicitly overrides this protocol, this repository should use:

- `codex` for orchestration and final review
- `claude` for lighter execution
- `opencode` for heavier execution
- mandatory self-review before handoff
- mandatory `codex` review before acceptance
