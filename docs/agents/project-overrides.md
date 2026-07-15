# Kaoyan Math Mistake Book App Project Overrides

## Project state

This repository contains a local-first desktop application for managing postgraduate mathematics mistakes, spaced review, knowledge maps, practice banks, study supervision, and task planning. The stack is Electron, React, TypeScript, Vite, and `sql.js`.

The repository is an active Git worktree. Preserve all existing uncommitted changes and do not modify unrelated files.

## Primary context

- `README.md`: product purpose, feature overview, privacy model, local data layout, and development commands.
- `KNOWN_ISSUES.md`: active limitations and known regressions.
- `ROADMAP.md`: current priorities and delivery status.
- `docs/tasks/`: task breakdowns and execution records; treat completed records as historical unless a task explicitly authorizes updating them.
- `docs/superpowers/plans/`: existing implementation plans. Their presence does not authorize invoking Superpowers; the user must explicitly request it in the current turn.
- `src/main/`: Electron main process, IPC, persistence, and local services.
- `src/renderer/`: React renderer and user-facing workflows.
- `src/shared/`: shared types and cross-process contracts.
- `tests/`: Node test suites for main-process and IPC behavior.

Read only the documents relevant to the current task. When active documents conflict, verify the implementation and report the conflict instead of silently choosing one.

## Commands

- File discovery: `rg --files`
- Text search: `rg -n "<pattern>" <paths>`
- Dependency installation: `npm install`
- Development: `npm run dev`
- Main-process build: `npm run build:main`
- Type checking: `npm run typecheck`
- Tests: `npm test`
- Main-process tests: `npm run test:main`
- Production build: `npm run build`
- Windows portable packaging: `npm run pack:win`

Use the narrowest validation that covers the change, then expand validation in proportion to regression risk. Do not claim a command passed unless it actually ran successfully.

## Local boundaries

- Preserve the local-first privacy model. Do not upload user mistakes, images, textbooks, databases, backups, API keys, or other private study data.
- Do not commit generated or private artifacts such as `node_modules/`, `dist/`, `release/`, `*.db`, or contents of data, image, textbook, export, backup, and temp directories.
- Treat destructive database restoration, import rollback, file migration, and deletion flows as high risk. Use disposable test data or the existing test harness for validation.
- Preserve renderer/main/preload boundaries and shared IPC contracts when changing cross-process behavior.
- Do not change the default external data directory `D:\KaoyanMathMistakeBook` or migrate real user data unless the user explicitly requests it.
- Do not install global tools, publish packages or releases, push changes, or restart Paseo without explicit user authorization.

## Documentation organization

- Put new documents in a purpose-specific directory instead of the repository root.
- Use `docs/design/` for design and architecture notes, `docs/tasks/` for active task breakdowns, `docs/superpowers/plans/` only for explicitly requested Superpowers plans, and `docs/archive/` for superseded documents.
- Preserve historical context when archiving or annotating completed task records.

## Known Paseo environment

- Paseo MCP is the default orchestration channel for this repository.
- Model and provider availability is dynamic; the coordinator must run Paseo discovery before agent creation.
- Existing CCB-oriented history or artifacts do not override the root orchestration boundary.
