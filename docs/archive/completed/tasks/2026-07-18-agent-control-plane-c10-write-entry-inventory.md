# C10 Study Write-Entry Inventory

## Evidence and scope

Inventory performed against accepted C9 commit `a9f19c1` and the C10 working
tree. The study domain's historical implementation is
`src/main/services/studySupervisorService.ts`; Renderer registration is in
`src/main/ipc/registerIpc.ts`; preload exposure is `src/preload/preload.ts`.

## Writer/read entry inventory

| Area | Entry | Evidence | C10 disposition |
| --- | --- | --- | --- |
| Supervisor initialization | `initializeStudySupervisor` | `studySupervisorService.ts:213` | Startup schema/default writer remains internal only; not exposed. |
| Rollover | `rolloverStudyTasks` | `studySupervisorService.ts:548` | Timer/manual legacy writer remains internal only; no C10 autonomous schedule. |
| Timer/session | `createStudySession` | `studySupervisorService.ts:623` | C10 manual progress uses the application command and records one session only. |
| Daily review | `getDailyReview`, `saveDailyReview` | `studySupervisorService.ts:682,686` | Historical review persistence remains unexposed. C10 reads bounded daily supervision state. |
| Daily dashboard | `getStudySupervisorDashboard` | `studySupervisorService.ts:749` | C10 replaces the external variant with `study.get_today`; legacy Renderer route remains unrelated. |
| Plan generation | `createStudyTask` | `studySupervisorService.ts:436` | C10 `study.create_plan_draft` creates at most twenty explicit draft tasks through `application/study`. |
| Plan adjustment | `updateStudyTask`, `skipStudyTask` | `studySupervisorService.ts:471,534` | C10 `study.apply_plan_adjustment` adjusts one named task through `application/study`; no batch/rollover behavior. |
| Manual material progress | `updateStudyMaterialProgress` | `studySupervisorService.ts:384` | C10 may update one explicitly named material only while recording one manual session. |
| Renderer parity | fixed principal IPC adapters | `ipc/adapters/studyIpc.ts` | All five C10 operations use the fixed Renderer principal and `AgentGateway`. |

## Exact external set

- `study.get_today`: bounded date-specific supervision summary.
- `study.get_week_summary`: bounded Monday-through-requested-date aggregate.
- `study.create_plan_draft`: create at most twenty explicit tasks for one date.
- `study.apply_plan_adjustment`: adjust one explicit task.
- `study.record_manual_progress`: record one session and optionally reconcile one task/material.

No timer, supervisor initialization, rollover, daily-review persistence, autonomous
scheduling, retry, dependency graph, or week-long execution operation is exposed.

## Boundary evidence

`src/main/application/study/*` owns C10 handler reads/writes through a business
capability. Gateway composition dispatches the exact study command/query unions.
MCP and Renderer adapters construct only authenticated Gateway envelopes; they do
not import study services, SQL helpers, or `DatabaseCoordinator` capabilities.

Stored task titles, notes, and imported text are treated as untrusted data in the
C10 prompts. Prompts refer only to explicitly registered study/public tools and
cannot grant scopes or invoke hidden operations.
