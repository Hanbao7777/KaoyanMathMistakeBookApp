# Agent Collaboration Rules

## Scope and precedence

These rules apply to every agent working in this repository. Direct user instructions override this file. This file overrides all documents under `docs/agents/`. If instructions conflict and precedence does not resolve the conflict, stop and ask the coordinator.

## Required reading

Before starting work:

1. Read this file.
2. Read `docs/agents/README.md`.
3. Coordinators read `docs/agents/coordinator.md` and `docs/agents/model-routing.md`.
4. Paseo child agents read `docs/agents/worker.md` and `docs/agents/project-overrides.md`.
5. Read every project document named in the task prompt. Read a Superpowers skill only when the user explicitly requested Superpowers or that specific skill in the current request and the dispatch lists it.

## Orchestration boundary

- Paseo MCP is the only default channel for creating, prompting, supervising, and archiving agents.
- Do not use CCB, Orca, native subagent APIs, or another orchestrator unless the user explicitly authorizes it in the current request.
- Do not invoke Superpowers or any specific Superpowers skill unless the user explicitly requests it in the current request. Never infer authorization from the task type, complexity, or applicability of a skill.
- When the user explicitly requests a Superpowers skill and it calls for an agent or subagent, implement that step with Paseo MCP.
- Do not restart the Paseo daemon without explicit user approval.

## Coordinator rules

- The coordinator is responsible for understanding, decomposing, dispatching, debugging, and verifying work without relying on an automatically selected skill.
- Decide whether delegation adds value before creating an agent.
- Classify each delegated task as simple, medium, hard, or ultra-hard and follow `docs/agents/model-routing.md`.
- Define objective, allowed scope, forbidden scope, file ownership, validation, and expected response before dispatch.
- Default to `relationship: subagent` and `notifyOnFinish: true`.
- Give every Worker the provider's highest available permission mode (for example `full-access` or `bypassPermissions`) after provider discovery. Runtime permission level does not broaden the task's allowed scope, file ownership, destructive-action authority, or external-side-effect authority.
- After dispatch, do not poll agent status, activity, terminals, or worktree changes. Wait for Paseo daemon notifications. A single status inspection is allowed only when the user explicitly asks for status or a daemon notification requires diagnosis.
- Use `detached` only for an explicit full ownership transfer requested by the user.
- Verify every returned claim, test result, and file change before accepting it.
- Directly inspect the Worker's files, validation evidence, and report for final acceptance. Do not create a separate reviewer unless the user explicitly requests independent review in the current request.
- Archive agents that are complete, abandoned, or replaced.

## Worker rules

- Follow `docs/agents/worker.md` regardless of task type.
- Stay within the dispatched scope and file ownership.
- Do not create or prompt another agent unless the coordinator explicitly authorizes it.
- Do not expand permissions, change requirements, or modify unrelated files.
- Before reporting completion, self-review the changed files, scope compliance, and validation evidence.
- Report completed, partial, blocked, and failed work using the required response format.

## Shared workspace safety

- Agents in the current workspace see the same files immediately.
- Only one writer may own a file or feature area at a time.
- Use a Paseo worktree for independent write-heavy tasks that may conflict.
- Keep tasks that depend on current uncommitted files in the current workspace.

## Completion standard

Work is complete only after the Worker self-reviews its files and evidence and the coordinator directly performs final acceptance. Scope must be satisfied, relevant validation must have run, evidence must be reported, risks must be explicit, and modified files must be listed.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
