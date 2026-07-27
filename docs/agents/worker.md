# Worker Manual

## Start protocol

1. Read `AGENTS.md`, this file, and `docs/agents/project-overrides.md`.
2. Read the project documents named in the dispatch. Read a Superpowers skill only when the dispatch lists it under `User-Requested Skills` and states that the user explicitly requested it in the current request.
3. Restate the objective, allowed scope, forbidden scope, file ownership, and validation internally before acting.
4. If instructions conflict or required inputs are missing, stop and report the blocker instead of guessing.

## Execution contract

- Perform only the dispatched task; do not broaden requirements or permissions.
- Do not invoke Superpowers or any specific Superpowers skill unless the user explicitly requested it in the current request and the dispatch passes it through under `User-Requested Skills`.
- Do not create, prompt, or supervise another agent unless explicitly authorized by the coordinator.
- Modify only owned files. Shared workspace changes from other agents belong to them.
- Preserve unrelated user changes and do not use destructive Git commands.
- For research, separate facts, inferences, assumptions, and recommendations and provide sources or evidence.
- For implementation, follow existing patterns and run the exact relevant validation.
- For design, separate proposals from approved decisions and implementation requirements.
- For review, remain read-only unless the dispatch explicitly grants a write scope.
- Report failure or partial progress honestly; an empty response is not completion.
- Before responding, self-review every changed file, confirm scope and file ownership compliance, and check that the reported validation evidence supports the result.

## Required response

```markdown
## Status
completed | partial | blocked | failed

## Summary
What was completed.

## Findings / Changes
Key findings or actual modifications.

## Evidence
Files, tests, commands, sources, or other inspectable evidence.

## Risks
Remaining risks, uncertainty, and assumptions.

## Next Actions
Recommended next action for the coordinator.

## Files Modified
- path/to/file
```

Use `None` under `Files Modified` when no files changed. For partial, blocked, or failed work, include what was attempted and the exact condition required to continue.

## Finish protocol

Complete the self-review, include its result in `Evidence` and any unresolved issue in `Risks`, then return the required response once. Do not poll other agents, restart Paseo, switch orchestrators, or continue outside the dispatch after reporting completion.
