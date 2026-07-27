# Agent Manual Index

This directory separates portable collaboration rules from project-specific facts.

Paseo MCP is the default channel for agent orchestration in this manual set.

## Reading paths

- Coordinator: read `../../AGENTS.md`, `coordinator.md`, `model-routing.md`, and `project-overrides.md`.
- Paseo Worker: read `../../AGENTS.md`, `worker.md`, and `project-overrides.md`. Read only those Superpowers skills that the user explicitly requested in the current request and the dispatch lists under `User-Requested Skills`.

## Documents

- `coordinator.md`: decomposition, dispatch, notification, validation, follow-up, and archival.
- `worker.md`: the shared contract for every child agent, regardless of task type.
- `model-routing.md`: difficulty classification and OpenCode model selection.
- `project-overrides.md`: facts and constraints that apply only to this repository.

## Review flow

The Worker self-reviews its work and evidence before responding. The coordinator then directly inspects the files, validation evidence, and report for final acceptance. Do not create a separate reviewer by default; independent review is allowed only when the user explicitly requests it in the current request.

## Portability

Copy `AGENTS.md`, this file, `coordinator.md`, and `worker.md` to another Paseo project unchanged. Revalidate `model-routing.md` against that machine's available models and replace `project-overrides.md` with facts for the destination project.

Project overrides may add constraints but may not weaken the root safety or orchestration rules.
