# Coordinator Manual

## Purpose

The coordinator owns decomposition, difficulty classification, Paseo dispatch, conflict prevention, validation, and final communication with the user.

## Work method

1. Understand the user's requirements and split the work into independently verifiable tasks.
2. Do not invoke Superpowers or any specific Superpowers skill unless the user explicitly requests it in the current request; never infer authorization from task type or apparent applicability.
3. Keep tightly coupled or trivial work inline when delegation would add overhead.
4. For each delegated task, classify difficulty using `model-routing.md`.
5. Read `~/.paseo/orchestration-preferences.json` before choosing a provider. If it is missing, report that once and use the approved project routing.
6. Use Paseo provider/model discovery; never guess model, mode, thinking, or feature IDs.
7. Choose current workspace or a worktree and assign one writer per file area.
8. Create a Paseo `subagent` with `notifyOnFinish: true`.
9. Continue other work until the daemon sends completion, error, or permission notification. Do not poll.
10. Directly inspect the Worker's files, validation evidence, self-review, and report. Either accept the work, send the same Worker a focused follow-up, escalate that Worker's model when needed, or report a blocker.
11. Archive the agent when its context is no longer needed.

Do not create a separate reviewer by default. For high-risk work, require the same Worker to self-review and provide additional validation when needed, then perform final acceptance directly. An independent review agent is allowed only when the user explicitly requests independent review in the current request.

## Required dispatch prompt

Every prompt must contain:

```text
Read First:
Objective:
Context:
Difficulty: simple | medium | hard
User-Requested Skills: [optional]
Allowed Scope:
Forbidden Scope:
File Ownership:
Expected Deliverables:
Validation:
Response Format: use docs/agents/worker.md
Model Selection:
```

`User-Requested Skills` is optional. Include it only to pass through Superpowers or a specific Superpowers skill that the user explicitly requested in the current request; never populate it based on task type or coordinator judgment. `Model Selection` records the selected model, thinking option, and reason. The prompt must require the Worker to read `AGENTS.md`, `docs/agents/worker.md`, and `docs/agents/project-overrides.md`.

## Parallelism

- Parallelize independent research, user-requested read-only review, or isolated file ownership.
- Do not parallelize tasks that share mutable state or write the same files.
- Use separate Paseo worktrees for independent write-heavy tasks that do not need current uncommitted artifacts.
- Keep dependency chains shallow and dispatch only tasks whose prerequisites are complete.

## Model escalation

Use the configured fallback when the primary model is unavailable, errors, or returns no effective result. Reclassify upward when the task was underestimated, repeated attempts fail for reasoning-related causes, or evidence conflicts. Record the escalation reason; do not retry the same prompt indefinitely.

## Acceptance checklist

- The response addresses the original objective.
- The Worker followed the assigned scope and file ownership.
- The Worker reported a self-review of changed files, scope compliance, and validation evidence.
- Difficulty, model, and thinking match `model-routing.md`.
- Claims include inspectable evidence.
- Reported validation actually ran and covers the relevant risk.
- Modified files are listed and unrelated files were not changed.
- Risks, assumptions, failures, and remaining work are explicit.
- Conflicting results are resolved by directly inspecting evidence, requesting focused clarification or additional validation from the same Worker, or asking the user when evidence remains inconclusive.
- The agent or temporary worktree is archived when no longer needed.

## Prohibited coordinator behavior

- Do not replace Paseo MCP with CCB, Orca, native subagents, or persistent CLI waiting.
- Do not treat a daemon heartbeat or running status as completion.
- Do not accept an agent response as proof without validation.
- Do not automatically create a reviewer or independent review task, including for hard or high-risk work.
- Do not broaden user authorization to solve a coordination problem.
