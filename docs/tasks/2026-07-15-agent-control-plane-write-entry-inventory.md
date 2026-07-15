# Agent Control Plane Current Write-Entry Inventory

## Purpose and evidence standard

This is the Phase A migration baseline for the current repository. It inventories runtime entry points and implementation-level mutation surfaces, not only functions whose names contain create/update/delete. A row is classified as a write only when direct source evidence shows a database, filesystem, external-process, network, or UI side effect. Completed task records are historical context and are not used as proof without current source confirmation.

Source references use current `file:line` locations. Counts were reconciled on 2026-07-15 against `src/main/ipc/registerIpc.ts`, `src/main/main.ts`, and all exported functions in `src/main/services/*.ts`.

Reference key: `registerIpc.ts` means `src/main/ipc/registerIpc.ts`; `main.ts` means `src/main/main.ts`; every `*Service.ts` and `focusTimerEngine.ts` basename means the matching file under `src/main/services/`. A leading `:line` in a table continues the fully named file from that table section. Planned paths in the implementation plan are intentionally absent until their owning task runs.

## Classification

- **Kind:** `W` writes durable DB/files; `M` mixes reads with writes or external/UI effects; `E` external process/network without local durable write; `U` UI/window/shell side effect; `R` read-only.
- **Side effects:** `DB`, `FS`, `PROC`, `NET`, `UI`, or `MEM`.
- **Risk:** architecture risk levels `R0`-`R4`. UI opens are generally R1; single-record reversible writes R2; batch/cross-domain work R3; destructive replacement, clear, restore, or root migration R4.
- **Disposition:** `A-Q` must migrate for the Phase A questions-domain gate; `A-K` must enter the Phase A kernel although its full domain is deferred; `D` is deferred to later domain migration; `RO` remains an evidence-backed read-only exception; `EXT` remains an explicit external/UI operation behind a future catalog.

## Reconciliation totals

| Surface | Current count | Evidence |
| --- | ---: | --- |
| Wrapped `handle('channel', ...)` registrations | 144 | `src/main/ipc/registerIpc.ts:281-573`; `git grep -c "handle('"` returned 144 |
| Direct `ipcMain.on` registrations | 8 | widget channels at `registerIpc.ts:537-572`; window state at `main.ts:173` |
| Direct `ipcMain.handle` registrations | 1 | `window:loadState` at `main.ts:174` |
| Exported service declarations | 165 | per-service `git grep -c -E "^export (async )?function|^export const|^export class"`; counts retained in reconciliation checklist |

The wrapped count includes read, write, mixed, process/network, and UI operations. The tables below classify all 144 wrapped channels plus all 9 direct registrations.

## IPC database and managed-file writes

| Channel | Kind | Domain | Side effects and direct evidence | Current transaction/persistence | Risk | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `questions:create` | W | questions | Creates question/tags/images; `registerIpc.ts:284`, `databaseService.ts:443-490` | Local SQL tx; image copies happen inside tx; direct whole-DB persist after commit | R2 | A-Q |
| `questions:update` | W | questions | Updates question, appends images, replaces tags; `registerIpc.ts:285`, `databaseService.ts:524-557` | No transaction; direct persist | R2 | A-Q |
| `questions:delete` | W | questions/files | Deletes row and optionally unlinks image files; `registerIpc.ts:286`, `databaseService.ts:595-601` | No transaction/journal; file delete before persist, errors swallowed | R4 when files, else R2 | A-Q |
| `questions:markMastery` | W | questions/review | Updates mastery and review date; `registerIpc.ts:287`, `databaseService.ts:739-748` | No tx; direct persist | R2 | A-Q |
| `images:remove` | W | questions/files | Deletes image row and optionally file; `registerIpc.ts:288`, `databaseService.ts:604-610` | No tx/journal; direct persist | R3 with file | A-Q |
| `reviews:add` | W | reviews/questions | Inserts review and updates question counters; `registerIpc.ts:295`, `databaseService.ts:730-736` | Delegates local tx then persist | R2 | A-Q because it writes question-owned state |
| `reviews:submitResult` | W | reviews/questions | Same writer with structured result; `registerIpc.ts:296`, `databaseService.ts:654-727` | SQL tx, persist after commit | R2 | A-Q |
| `settings:export` | M | operations/export | Reads many tables and writes JSON; `registerIpc.ts:300`, `databaseService.ts:928-956` | No journal; direct `writeFileSync` | R2 | D/EXT; kernel FS operation |
| `settings:import` | W | operations/all domains | Backup copy, deletes/reinserts many tables including all question tables; `registerIpc.ts:302`, `databaseService.ts:967-1367` | One SQL tx; backup is raw live-file copy; direct persist | R4 | A-Q and A-K replacement path |
| `settings:clear` | W | operations/all domains | Deletes many tables and optional images; `registerIpc.ts:303`, `databaseService.ts:1370-1378` | No SQL tx/journal; file deletion errors swallowed; direct persist | R4 | A-Q and A-K |
| `settings:setRoot` | W | operations/path | Writes root config, optional recursive copy, closes/reopens DB; `registerIpc.ts:305-312`, `pathService.ts:92-113` | No fence, journal, hash verification, or rollback | R4 | A-K; A-Q because DB identity changes |
| `backups:create` | W | backup | Persists live DB then copies file; `registerIpc.ts:313`, `backupService.ts:49-56` | Raw persist + copy; no candidate validation | R3 | A-K |
| `backups:ensureDaily` | M | backup | May create backup and deletes old auto backups; `registerIpc.ts:314`, `backupService.ts:89-99,59-75` | No journal; unlink failures ignored | R3 | A-K |
| `backups:restore` | W | backup/operations | Creates protection backup then overwrites live DB and resets connection; `registerIpc.ts:316`, `backupService.ts:121-145` | Raw copy replacement; best-effort copy rollback; no integrity/epoch | R4 | A-K and A-Q |
| `backups:delete` | W | backup/files | Unlinks selected backup; `registerIpc.ts:317`, `backupService.ts:148-152` | No quarantine/journal | R4 | A-K |
| `pdfExport:create` | M | export/questions | Reads questions, creates hidden window, prints and writes PDF; `registerIpc.ts:319`, `pdfExportService.ts:219-241` | No journal; direct output write | R2 | D/EXT |
| `structuredImport:template` | W | import/export | Writes XLSX template; `registerIpc.ts:322`, `structuredImportService.ts:187-211` | Direct library file write | R2 | D/EXT |
| `structuredImport:prepareZip` | M | import | Extracts untrusted zip to temp and records in-memory session; `registerIpc.ts:325`, `structuredImportService.ts:228-263` | Safe-path precheck; temp cleanup on error; no journal | R2 | A-K for staging framework |
| `structuredImport:confirm` | W | import/questions/files | Creates batch, creates questions/images/links row-by-row, finalizes batch; `registerIpc.ts:326`, `structuredImportService.ts:289-343` | Multiple nested per-question persists; no encompassing tx/journal; partial success is allowed | R3 | A-Q |
| `structuredImport:cancel` | W | import/temp | Recursively deletes session temp; `registerIpc.ts:327`, `structuredImportService.ts:346-353` | No journal; idempotent missing-session behavior | R2 | A-K |
| `knowledgeMap:importZip` | W | knowledge/files | Temp extraction, optional PDF copy, textbook/knowledge/batch writes; `registerIpc.ts:328`, `knowledgeMapService.ts:318-395` | SQL tx but file copy occurs inside and is not compensated; direct persist | R3 | A-K; full domain D |
| `knowledgeMap:bindTextbookPdf` | W | knowledge | Stores selected external absolute path; `registerIpc.ts:332`, `knowledgeMapService.ts:677-695` | No tx; direct persist; no managed copy | R2 | D |
| `knowledgeMap:rematch` | W | questions/knowledge | Inserts question-knowledge links; `registerIpc.ts:333`, `knowledgeMapService.ts:739-798` | SQL tx and direct persist | R3 | A-Q |
| `questionBank:importZip` | W | question bank/files | Extracts/copies assets and writes batch/questions; `registerIpc.ts:338`, `questionBankService.ts:281-460` | SQL tx after files already copied; failed status best effort; no journal | R3 | A-K; full domain D |
| `questionBank:recordAttempt` | W | question bank | Inserts attempt; `registerIpc.ts:343`, `questionBankService.ts:681-700` | No tx; direct persist | R2 | D |
| `questionBank:addToMistakes` | W | question bank/questions/files | Creates question/images/links then updates external rows; `registerIpc.ts:344`, `questionBankService.ts:740-798` | Several independent persists; no parent tx/journal; partial outcome possible | R3 | A-Q |
| `questionBank:deleteBatch` | W | question bank/files | Deletes DB rows then renames batch asset directory to trash; `registerIpc.ts:345`, `questionBankService.ts:821-860` | DB tx and persist precede unjournaled filesystem move | R4 | A-K; full domain D |
| `importBatches:delete` | W | imports/cross-domain/files | Backup, deletes question/external rows, soft-deletes knowledge, moves assets; `registerIpc.ts:350`, `importBatchService.ts:159-239` | File moves occur inside SQL tx but are not rolled back; persist after commit | R4 | A-Q/A-K |
| `importBatches:deleteLegacyExternalGroup` | W | question bank/import | Backup then deletes legacy attempts/questions; `registerIpc.ts:352`, `importBatchService.ts:261-303` | SQL tx + persist; assets not moved despite result fields | R4 | A-K; full domain D |
| `study:settings:update` | W | study | Updates settings; `registerIpc.ts:355`, `studySupervisorService.ts:201-219` | `ensureStudyBase` may also migrate/seed; direct persists | R2 | D, coordinator-wrap |
| `study:materials:create` | W | study | Inserts material; `registerIpc.ts:358`, `studySupervisorService.ts:262-293` | No tx; direct persist | R2 | D |
| `study:materials:update` | W | study | Updates material; `registerIpc.ts:359`, `studySupervisorService.ts:295-323` | No tx; direct persist | R2 | D |
| `study:materials:delete` | W | study | Soft-deletes material; `registerIpc.ts:360`, `studySupervisorService.ts:325-330` | No tx; direct persist | R2 | D |
| `study:materials:updateProgress` | W | study | Updates progress; `registerIpc.ts:361`, `studySupervisorService.ts:332-341` | No tx; direct persist | R2 | D |
| `study:tasks:create` | W | study | Inserts task; `registerIpc.ts:364`, `studySupervisorService.ts:380-413` | No tx; direct persist | R2 | D |
| `study:tasks:update` | W | study | Updates task; `registerIpc.ts:365`, `studySupervisorService.ts:415-447` | No tx; direct persist | R2 | D |
| `study:tasks:delete` | W | study | Physically deletes task; `registerIpc.ts:366`, `studySupervisorService.ts:449-454` | No tx; direct persist | R3 | D |
| `study:tasks:complete` | W | study | Completes task; `registerIpc.ts:367`, `studySupervisorService.ts:456-475` | No tx; direct persist | R2 | D |
| `study:tasks:skip` | W | study | Marks skipped; `registerIpc.ts:368`, `studySupervisorService.ts:477-488` | No tx; direct persist | R2 | D |
| `study:tasks:rollover` | W | study | Moves all overdue tasks and updates last rollover; `registerIpc.ts:369`, `studySupervisorService.ts:490-519` | No SQL tx around batch; direct persist | R3 | D |
| `study:sessions:create` | W | study | Inserts session and increments linked task minutes; `registerIpc.ts:371`, `studySupervisorService.ts:560-595` | No tx across two writes; direct persist | R2 | D |
| `study:sessions:delete` | W | study | Deletes session without reversing task minutes; `registerIpc.ts:372`, `studySupervisorService.ts:597-602` | No tx; direct persist | R3 | D |
| `study:reviews:save` | W | study | Upserts daily review from current stats; `registerIpc.ts:374`, `studySupervisorService.ts:624-674` | No tx; direct persist | R2 | D |
| `deepseek:settings:save` | W | settings/secrets | Writes API settings into `app_settings`; `registerIpc.ts:379`, `deepseekService.ts:22-33` | **No `persistDatabase()` call**, so only in-memory until another persist/shutdown | R3 (secret) | A-K coordinator-wrap; future secret-storage redesign D |
| `ai:recordImport` | W | import metadata | Creates import batch and records question item; `registerIpc.ts:436-448` | Direct DB helpers; **no explicit persist**, durability depends on later write/shutdown | R2 | A-Q because it records an existing question relation |
| `ticktick:lists:create` | W | TickTick | `registerIpc.ts:453`, `ticktickService.ts:74-107` | No tx; direct persist | R2 | D |
| `ticktick:lists:update` | W | TickTick | `registerIpc.ts:454`, `ticktickService.ts:109-136` | No tx; direct persist | R2 | D |
| `ticktick:lists:delete` | W | TickTick | Cascade/bridge cleanup; `registerIpc.ts:455`, `ticktickService.ts:138-152` | Local tx + persist | R3 | D |
| `ticktick:lists:reorder` | W | TickTick | Batch updates sort order; `registerIpc.ts:456`, `ticktickService.ts:154-168` | Prepared loop without tx; direct persist | R3 | D |
| `ticktick:tasks:create` | W | TickTick | Creates task and tags; `registerIpc.ts:461`, `ticktickService.ts:316-374` | No tx across task/tags; direct persist | R2 | D |
| `ticktick:tasks:update` | W | TickTick | Dynamic patch; `registerIpc.ts:462`, `ticktickService.ts:376-468` | No tx; direct persist | R2 | D |
| `ticktick:tasks:delete` | W | TickTick | Recursively deletes descendants/bridges; `registerIpc.ts:463`, `ticktickService.ts:470-495` | Local tx + persist | R3 | D |
| `ticktick:tasks:complete` | W | TickTick/review | Completes task then review bridge sync; `registerIpc.ts:464`, `bridgeService.ts:174-183` | Separate persists; sync error swallowed, parent still succeeds | R3 | A-Q for review write; TickTick full migration D |
| `ticktick:tasks:uncomplete` | W | TickTick/review | Uncompletes task then deletes synced review logs; `registerIpc.ts:465`, `bridgeService.ts:186-195` | Separate persists; undo error swallowed | R3 | A-Q |
| `ticktick:focus:create` | W | focus | Inserts focus session; `registerIpc.ts:473`, `ticktickService.ts:613-647` | No tx; direct persist | R2 | D |
| `ticktick:bridge:create` | W | bridge | Inserts bridge; `registerIpc.ts:477`, `ticktickService.ts:660-692` | No tx; direct persist | R2 | D |
| `ticktick:bridge:delete` | W | bridge | Deletes bridge; `registerIpc.ts:478`, `ticktickService.ts:694-699` | No tx; direct persist | R2 | D |
| `ticktick:settings:save` | W | TickTick settings | Upserts JSON settings; `registerIpc.ts:491`, `ticktickService.ts:849-871` | No tx; direct persist | R2 | D |
| `ticktick:habits:create` | W | habits | `registerIpc.ts:495`, `ticktickService.ts:920-935` | No tx; direct persist | R2 | D |
| `ticktick:habits:update` | W | habits | `registerIpc.ts:496`, `ticktickService.ts:937-946` | No tx; direct persist | R2 | D |
| `ticktick:habits:delete` | W | habits | `registerIpc.ts:497`, `ticktickService.ts:948-953` | No tx; direct persist | R3 | D |
| `ticktick:habits:toggle` | W | habits | Insert/delete habit log; `registerIpc.ts:498`, `ticktickService.ts:955-989` | In-memory process guard only; direct persist | R2 | D |
| `ticktick:sync:reviewTask` | W | bridge/review/study | Writes review/question or study task; `registerIpc.ts:502`, `bridgeService.ts:11-55` | Per-review nested tx/persist plus final persist; errors swallowed | R3 | A-Q |
| `ticktick:sync:undoReviewTask` | W | bridge/review | Deletes matching review logs; `registerIpc.ts:503`, `bridgeService.ts:162-171` | No question-counter compensation; direct persist | R3 | A-Q |
| `ticktick:sync:generateReviewTasks` | W | bridge/TickTick | Creates default list/tasks/bridges; `registerIpc.ts:504`, `bridgeService.ts:98-159` | No tx; one final persist | R3 | D, coordinator-wrap |
| `ticktick:sync:reviewUpdated` | W | bridge/TickTick | Completes linked tasks; `registerIpc.ts:505`, `bridgeService.ts:58-77` | No tx; final persist | R3 | D |
| `ticktick:sync:masteryChanged` | W | bridge/TickTick | Updates linked priorities; `registerIpc.ts:506`, `bridgeService.ts:80-95` | No tx; final persist | R3 | D |
| `ticktick:whiteNoise:set` | W | settings | Direct `app_settings` upsert from IPC; `registerIpc.ts:517-522` | No tx; direct persist via dynamic import | R2 | A-K; remove direct IPC DB access |

## IPC mixed reads with hidden writes

| Channel | Why it is not read-only | Evidence | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `study:settings:get` | `ensureStudyBase` alters columns, seeds settings/subjects, and persists | `registerIpc.ts:354`; `studySupervisorService.ts:165-194` | R3 on first call | A-K split bootstrap command; query D |
| `study:subjects:list` | Same `ensureStudyBase` writer | `registerIpc.ts:356`; `studySupervisorService.ts:221-226` | R3 on first call | A-K split |
| `study:materials:list` | Same `ensureStudyBase` writer | `registerIpc.ts:357`; `studySupervisorService.ts:237-260` | R3 on first call | A-K split |
| `study:tasks:list` | Same `ensureStudyBase` writer | `registerIpc.ts:362`; `studySupervisorService.ts:354-372` | R3 on first call | A-K split |
| `study:tasks:today` | Calls `rolloverStudyTasks`, changing dates/settings | `registerIpc.ts:363`; `studySupervisorService.ts:521-524` | R3 | A-K split command/query |
| `study:sessions:list` | Same `ensureStudyBase` writer | `registerIpc.ts:370`; `studySupervisorService.ts:536-558` | R3 on first call | A-K split |
| `study:reviews:get` | Same `ensureStudyBase` writer | `registerIpc.ts:373`; `studySupervisorService.ts:619-622` | R3 on first call | A-K split |
| `study:dashboard` | Calls rollover before reading dashboard | `registerIpc.ts:375`; `studySupervisorService.ts:689-700` | R3 | A-K split |
| `ticktick:tags:list` | Deletes unused tag rows and persists while listing | `registerIpc.ts:469`; `ticktickService.ts:554-579` | R3 | A-K split cleanup command |
| `ticktick:settings:get` | Executes `CREATE TABLE IF NOT EXISTS app_settings` | `registerIpc.ts:490`; `ticktickService.ts:827-847,44-46` | R2 | A-K bootstrap split |
| `backups:list` | Ensures backup directory via `mkdirSync` | `registerIpc.ts:315`; `backupService.ts:20-23,102-119` | R1 | D/EXT; catalog as FS mixed |
| `backups:openFolder` | Ensures directory then opens shell | `registerIpc.ts:318`; `backupService.ts:155-159` | R1 | EXT |
| `pdfExport:openFolder` | Ensures directory then opens shell | `registerIpc.ts:321`; `pdfExportService.ts:251-256` | R1 | EXT |
| `importBatches:openTrashFolder` | Ensures trash directory then opens shell | `registerIpc.ts:353`; `importBatchService.ts:306-311` | R1 | EXT |

## IPC process, network, UI, and in-memory side effects

| Channel | Kind | Side effect | Evidence | Risk | Disposition |
| --- | --- | --- | --- | --- | --- |
| `images:choose` | U | Native file chooser | `registerIpc.ts:289`, `fileService.ts:40-47` | R1 | EXT |
| `images:open` | U | Opens local path in shell | `registerIpc.ts:292`, `imageService.ts:49-53` | R1 | EXT |
| `images:reveal` | U | Reveals local file | `registerIpc.ts:293`, `imageService.ts:55-59` | R1 | EXT |
| `settings:chooseJson` | U | Native file chooser | `registerIpc.ts:301`, `fileService.ts:49-56` | R1 | EXT |
| `settings:chooseRoot` | U | Native directory chooser | `registerIpc.ts:304`, `fileService.ts:58-64` | R1 | EXT |
| `pdfExport:open` | U | Opens selected PDF path | `registerIpc.ts:320`, `pdfExportService.ts:244-248` | R1 | EXT |
| `structuredImport:prepareExcel` | U | Chooser plus file parse, in-memory session | `registerIpc.ts:323`, `structuredImportService.ts:214-219` | R1 | EXT |
| `structuredImport:prepareJson` | U | Chooser plus file parse, in-memory session | `registerIpc.ts:324`, `structuredImportService.ts:221-226` | R1 | EXT |
| `knowledgeMap:openTextbookPage` | U | Opens external/file URL | `registerIpc.ts:331`, `knowledgeMapService.ts:645-675` | R1 | EXT |
| `questionBank:openPaper` | U | Opens local paper PDF | `registerIpc.ts:346`, `questionBankService.ts:801-809` | R1 | EXT |
| `questionBank:openSolutionPdf` | U | Opens local solution PDF | `registerIpc.ts:347`, `questionBankService.ts:811-819` | R1 | EXT |
| `ocr:run` | E | Spawns Python once per image | `registerIpc.ts:382`, `ocrService.ts:24-74` | R3 | EXT; future job/catalog |
| `deepseek:structure` | E | Sends OCR/user content to configured network endpoint | `registerIpc.ts:385`, `deepseekService.ts:145-153,36-64` | R3 | EXT; future disclosure/catalog |
| `deepseek:diagnose` | M | Reads question then sends content to network | `registerIpc.ts:388-398` | R3 | EXT |
| `python:checkEnv` | E | Executes configured Python import check | `registerIpc.ts:401-409` | R3 | EXT |
| `deepseek:testConnection` | E | Sends network request containing API key auth | `registerIpc.ts:412-433` | R3 | EXT |
| `ticktick:ai:decompose` | E | Reads weak question data conditionally and calls DeepSeek | `registerIpc.ts:485`, `ticktickAiService.ts:92-165` | R3 | EXT |
| `ticktick:ai:dailyPlan` | E | Reads questions/tasks/settings and calls DeepSeek | `registerIpc.ts:486`, `ticktickAiService.ts:169-242` | R3 | EXT |
| `ticktick:ai:review` | E | Reads task/focus/review aggregates and calls DeepSeek | `registerIpc.ts:487`, `ticktickAiService.ts:246-300` | R3 | EXT |
| `timer:start` | M | Mutates main-process timer state | `registerIpc.ts:526`, `focusTimerEngine.ts:75-89` | R1 | D; MEM command |
| `timer:pause` | M | Mutates timer state | `registerIpc.ts:527`, `focusTimerEngine.ts:91-96` | R1 | D |
| `timer:reset` | M | Mutates timer state | `registerIpc.ts:528`, `focusTimerEngine.ts:98-109` | R1 | D |
| `timer:skipBreak` | M | Mutates timer state | `registerIpc.ts:529`, `focusTimerEngine.ts:111-119` | R1 | D |
| `timer:bindTask` | M | Mutates bound task in memory | `registerIpc.ts:530`, `focusTimerEngine.ts:67-69` | R1 | D |
| `timer:setConfig` | M | Mutates timer config in memory | `registerIpc.ts:531-534`, `focusTimerEngine.ts:54-61` | R1 | D |
| `widget:open` | U | Creates/focuses widget window | `registerIpc.ts:537`, `registerIpc.ts:217-269` | R1 | EXT/UI |
| `widget:close` | U | Closes widget, close hook writes state file | `registerIpc.ts:538-540,267` | R1 | EXT/UI/FS |
| `widget:togglePin` | U | Changes window and writes widget state | `registerIpc.ts:541-546` | R1 | EXT/UI/FS |
| `widget:setOpacity` | U | Changes window opacity | `registerIpc.ts:547-549` | R1 | EXT/UI |
| `widget:setSize` | U | Changes size and writes widget state | `registerIpc.ts:550-557` | R1 | EXT/UI/FS |
| `widget:setBounds` | U | Changes bounds and writes widget state | `registerIpc.ts:558-571` | R1 | EXT/UI/FS |
| `widget:openMain` | U | Shows/focuses main window | `registerIpc.ts:572`, `registerIpc.ts:271-278` | R1 | EXT/UI |
| `window:saveState` | U | Ignores payload and writes current bounds | `main.ts:173`, `main.ts:46-58` | R1 | EXT/UI/FS |

## IPC read-only channels

These channels have no direct mutation in their handler/service after normal startup initialization. Shell/open, chooser, network, mixed-read, and hidden-write channels are intentionally excluded and listed above.

| Domain | Read-only channels | Evidence |
| --- | --- | --- |
| Dashboard/questions | `dashboard:get`, `questions:list`, `questions:get` | `registerIpc.ts:281-283`; query bodies `databaseService.ts:493-522,751-804` |
| Images | `images:getUrl`, `images:exists` | `registerIpc.ts:290-291`; `imageService.ts:34-46` |
| Reviews/stats/paths | `reviews:list`, `review:buckets`, `stats:get`, `paths:get` | `registerIpc.ts:294,297-299`; `databaseService.ts:613-619,806-925,1388-1390` |
| Structured import | None beyond prepare operations, which have chooser/session/temp side effects | `registerIpc.ts:322-327` |
| Knowledge | `knowledgeMap:listTree`, `knowledgeMap:getDetail`, `knowledgeMap:listForQuestion`, `knowledgeMap:listReviewStats`, `knowledgeMap:getReviewStats`, `knowledgeMap:getReviewQuestions` | `registerIpc.ts:329-330,334-337`; `knowledgeMapService.ts:498-643` |
| Question bank | `questionBank:list`, `questionBank:get`, `questionBank:stats`, `questionBank:getAssetUrl` | `registerIpc.ts:339-342`; `questionBankService.ts:505-679` |
| Import batches | `importBatches:list`, `importBatches:getDetail`, `importBatches:listLegacyExternalGroups` | `registerIpc.ts:348-349,351`; `importBatchService.ts:83-103,241-259` |
| Study | None of the public study reads are pure today because all call `ensureStudyBase`, and today/dashboard additionally roll over tasks | `studySupervisorService.ts:165-194,521-524,689-700` |
| DeepSeek settings | `deepseek:settings:get` | `registerIpc.ts:378`, `deepseekService.ts:10-20` |
| TickTick lists/tasks | `ticktick:lists:list`, `ticktick:lists:get`, `ticktick:tasks:list`, `ticktick:tasks:get`, `ticktick:tasks:today` | `registerIpc.ts:451-452,459-460,466`; `ticktickService.ts:52-72,225-313,505-550` |
| TickTick focus/bridge/calendar | `ticktick:focus:list`, `ticktick:bridge:task`, `ticktick:bridge:linked`, `ticktick:calendar:month` | `registerIpc.ts:472,476,479,482`; `ticktickService.ts:583-611,651-658,701-711,715-811` |
| TickTick habits | `ticktick:habits:list`, `ticktick:habits:logs` | `registerIpc.ts:494,499`; `ticktickService.ts:877-918,991-1003` |
| TickTick white noise | `ticktick:whiteNoise:get` | Direct select only at `registerIpc.ts:509-516` |
| Timer/widget/window | `timer:getState`, `widget:isOpen`, `window:loadState` | `registerIpc.ts:525,573`; `main.ts:174`; state reads only |

## Startup, lifecycle, timers, and callbacks

| Entry | Trigger | Side effects | Current protection | Risk | Disposition |
| --- | --- | --- | --- | --- | --- |
| `initializePaths` | `app.whenReady` | Creates all root directories, write-test file, possible warning UI | No journal; fallback root on failure | R3 | A-K bootstrap |
| `initializeDatabase` / first `getDatabase` | `app.whenReady` | Opens/creates DB, executes schema/migrations, persists full DB | No atomic publish or recovery matrix | R4 on migration failure | A-K |
| Bundled seed import | Empty knowledge table at startup | Temp extraction, batch/textbook/knowledge writes | SQL tx; temp cleanup; no file journal | R3 | A-K coordinator internal command |
| Category migration | Every startup | Updates question categories even if no rows match | SQL tx + direct persist | R3 | A-Q |
| Question/knowledge rematch | Every startup | Scans all questions and inserts missing links | SQL tx + direct persist | R3 | A-Q |
| Daily auto backup | Every startup | May persist/copy DB and unlink old backups | No verified candidate/journal | R3 | A-K |
| Main window resize/move debounce | Window events | Writes `window-state.json` after 500 ms | Best-effort write, errors ignored | R1 | EXT/UI |
| Main window close | Window event | Writes state then quits | Best effort | R1 | EXT/UI |
| `before-quit` | App lifecycle | Direct whole-DB persist, destroys windows | Errors logged; no drain/atomic publish | R4 if overwrite fails | A-K |
| `will-quit` | App lifecycle | Unhandles protocol, OCR cleanup stub, closes DB | No pending-write drain | R2 | A-K |
| Focus engine `setInterval` | Module load, every 500 ms | Mutates timer memory | Singleton interval, no shutdown clear shown | R1 | D |
| Focus session-end callback | Timer reaches zero | Asynchronously inserts focus session; callback promise not awaited | Error logged only; timer proceeds | R2 | A-K coordinator internal command; domain D |
| Widget move/resize debounce | Widget events | Writes `widget-state.json` after 300 ms | Best effort | R1 | EXT/UI |
| Startup error handler | uncaught/unhandled/startup catch | Writes temp error log and shows error box | Best effort | R1 | EXT/UI |

Evidence: `main.ts:139-180,193-212`; `registerIpc.ts:164-185,202-215,253-269`; `focusTimerEngine.ts:121-164`.

## Direct persistence and generic mutation surfaces

| Surface | Evidence | Why it is a bypass risk | Phase A treatment |
| --- | --- | --- | --- |
| `persistDatabase()` | `databaseService.ts:78-83` | Exports mutable in-memory DB and directly overwrites live file; public and imported broadly | Replace with coordinator-owned atomic publish; remove public runtime use |
| `getDatabase()` | `databaseService.ts:85-103` | Returns mutable `sql.js.Database`; first call executes schema/migrations and persists | Split bootstrap, read facade, and coordinator-scoped mutation handle |
| `runSql(database, sql, params)` | `databaseService.ts:242-250` | Exported arbitrary SQL helper accepts mutation and has no execution-scope guard | Require coordinator token or replace with scoped repository helper |
| Raw `database.run` / `db.run` | Across all services, including `bridgeService.ts:47-50`, `ticktickService.ts:44-46`, and import services | Any caller with database handle can mutate without queue/revision | Static gate plus read-only facade; migrate by domain |
| Local SQL transactions | 13 begin sites across database, import, knowledge, question-bank, TickTick services | Serialize only local statements; persistence and files remain outside atomic boundary | Coordinator owns outer transaction; reject nested writer transactions |
| Direct dynamic DB IPC | `registerIpc.ts:438-447,510-522` | IPC writes batch metadata/white-noise settings without a service/application boundary | Replace with commands |
| Shutdown raw persist | `main.ts:193-199` | Can overwrite a newer/ambiguous candidate and does not drain writes | Coordinator drain and verified publish only |

## Service-level database writers

The following exported or directly callable functions are current implementation write entries. Helpers passed a mutable database are included because callers can compose them outside a transaction.

### Questions, reviews, and global data

| Function | Tables/files | Transaction and persistence | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `migrateCategoryValues` (`databaseService.ts:410`) | `questions` | Local tx + persist | R3 | A-Q internal command |
| `createQuestion` (`:443`) | `questions`, images, tags, links | SQL tx; files inside; persist after commit | R2/R3 | A-Q |
| `updateQuestion` (`:524`) | Same | No tx; direct persist | R2/R3 | A-Q |
| `linkQuestionKnowledgePoints` (`:567`) | `question_knowledge_points` | No tx; direct persist | R2 | A-Q |
| `deleteQuestion` (`:595`) | questions and optional images | No tx/journal; direct persist | R4 with files | A-Q |
| `removeImage` (`:604`) | `question_images`, optional file | No tx/journal; direct persist | R3 | A-Q |
| `submitReviewResult` / `addReviewLog` (`:654,:730`) | `review_logs`, `questions` | Local tx then persist | R2 | A-Q |
| `markMastery` (`:739`) | `questions` | No tx; direct persist | R2 | A-Q |
| `exportData` (`:928`) | Export JSON file | Direct file write | R2 | D/EXT |
| `importData` (`:967`) | Most domain tables and backup file | Local tx plus raw backup and persist | R4 | A-Q/A-K |
| `clearAllData` (`:1370`) | Most domain tables and optional images | No tx/journal; direct persist | R4 | A-Q/A-K |

### Import and batch helpers

| Function | Evidence/side effects | Current protection | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `createImportBatch` | DB insert; `importBatchService.ts:32-58` | No persist in function | R2 | A-K; A-Q when question batch |
| `recordImportBatchItem` | DB insert; `:60-66` | Caller-owned mutable DB; no persist | R2 | A-K/A-Q |
| `recordImportAsset` | DB insert; `:68-75` | Same | R2 | A-K |
| `finalizeImportBatch` | Count/update; `:77-81` | Same | R2 | A-K |
| `deleteImportBatch` | Cross-domain DB + asset moves; `:159-239` | Backup + SQL tx, no journal | R4 | A-Q/A-K |
| `deleteLegacyExternalQuestionGroup` | DB deletion; `:261-303` | Backup + SQL tx | R4 | A-K, domain D |
| `confirmStructuredImport` | Questions/images/links/batch; `structuredImportService.ts:289-343` | Partial row persists | R3 | A-Q |
| `cleanupStructuredImport` | Recursive temp delete; `:346-353` | No journal | R2 | A-K |

### Knowledge and question bank

| Function | Evidence/side effects | Current protection | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `importKnowledgeMapZip` | Temp/PDF + DB; `knowledgeMapService.ts:318-395` | SQL tx, unjournaled files | R3 | A-K; domain D |
| `seedImportKnowledgeMap` | Startup temp + DB; `:403-486` | SQL tx, unjournaled temp | R3 | A-K |
| `bindTextbookPdf` | Updates textbook path; `:677-695` | Direct persist | R2 | D |
| `rematchKnowledgePoints` | Inserts question links; `:739-798` | Local tx + persist | R3 | A-Q |
| `importQuestionBankZipFromPath` / `importQuestionBankZip` | Assets + DB; `questionBankService.ts:281-460` | SQL tx after copies | R3 | A-K; domain D |
| `recordExternalQuestionAttempt` | Attempt insert; `:681-700` | Direct persist | R2 | D |
| `addExternalQuestionToMistakes` | Question/images/links + external flags; `:740-798` | Multiple independent persists | R3 | A-Q |
| `deleteExternalQuestionBatch` | DB deletion then asset rename; `:821-860` | SQL tx, no journal | R4 | A-K; domain D |

### Study supervisor

`ensureStudyBase` is a private writer called by every exported study function (`studySupervisorService.ts:165-194`). It alters columns, inserts default rows, and persists. Therefore even nominal reads are mutation-capable until Phase A separates bootstrap.

Explicit exported writers are: `updateStudySettings` (`:201`), `createStudyMaterial` (`:262`), `updateStudyMaterial` (`:295`), `deleteStudyMaterial` (`:325`), `updateStudyMaterialProgress` (`:332`), `createStudyTask` (`:380`), `updateStudyTask` (`:415`), `deleteStudyTask` (`:449`), `completeStudyTask` (`:456`), `skipStudyTask` (`:477`), `rolloverStudyTasks` (`:490`), `createStudySession` (`:560`), `deleteStudySession` (`:597`), and `saveDailyReview` (`:624`). All use direct persistence and none uses a coordinator; only input-level validation is present. Full migration is deferred, but all must enter the common coordinator write queue as part of kernel adoption.

### TickTick, habits, focus, and bridge

| Writer group | Functions and evidence | Current protection | Risk | Disposition |
| --- | --- | --- | --- | --- |
| Lists | `create/update/delete/reorderTickTickLists`; `ticktickService.ts:74-168` | Delete uses local tx; others no tx; all persist | R2/R3 | D, coordinator-wrap |
| Tasks | `create/update/delete/complete/uncompleteTickTickTask`; `:316-503` | Delete local tx; others no tx; all persist through update paths | R2/R3 | D; completion bridge A-Q |
| Read cleanup | `listTickTickTags`; `:554-579` | Deletes rows during read and persists | R3 | A-K split |
| Focus | `createTickTickFocusSession`; `:613-647` | No tx; direct persist | R2 | D |
| Bridges | `create/deleteTickTickBridge`; `:660-699` | No tx; direct persist | R2 | D |
| Settings | `saveTickTickSettings`; `:849-871` | Direct persist | R2 | D |
| Habits | `create/update/delete/toggleTickTickHabit`; `:920-989` | Process-local toggle guard only; direct persist | R2/R3 | D |
| Cross-domain sync | `syncTaskCompletedToReview`, `syncReviewToTickTickTask`, `syncMasteryToTaskPriority`, `generateAutoReviewTasks`, `undoSyncTaskCompleted`, complete/uncomplete wrappers; `bridgeService.ts:11-208` | No encompassing tx; multiple persists; several swallowed failures | R3 | A-Q where review/question tables touched; otherwise D |

### Settings writer defect

`saveDeepSeekSettings` mutates `app_settings` but does not call `persistDatabase()` (`deepseekService.ts:22-33`). The IPC may report success while the setting exists only in memory until an unrelated persist or shutdown. This is a real current write entry and durability defect; Phase A must route it through the coordinator even though secret-storage redesign is deferred.

## Filesystem mutation inventory

| Operation | Evidence | Current behavior | Risk/disposition |
| --- | --- | --- | --- |
| Live DB overwrite | `databaseService.ts:78-83` | Direct `writeFileSync`, no temp/flush/reopen | R4, A-K |
| DB load/create/migration persist | `databaseService.ts:85-103,122-240` | Schema/migrations mutate then overwrite | R4, A-K |
| Question image copy | `fileService.ts:13-24` | Direct copy to final name | R3, A-Q journal |
| Question image delete | `fileService.ts:26-38` | Direct unlink, errors swallowed | R4, A-Q quarantine |
| JSON export | `databaseService.ts:953-956` | Direct final write | R2, D/EXT |
| Pre-import DB backup | `databaseService.ts:973-975` | Copies current live file without coordinator flush validation | R4, A-K |
| Backup create/cleanup/restore/delete | `backupService.ts:49-75,121-152` | Raw copies/unlinks/live overwrite | R3/R4, A-K |
| Root config write | `pathService.ts:28-31,92-97` | Direct config overwrite | R4, A-K atomic config |
| Root creation/write test | `pathService.ts:48-56` | Creates directories/temp probe | R3 startup, A-K |
| Root migration | `pathService.ts:100-114` | Recursive forced copy of six trees; no hash/switch rollback | R4, A-K |
| Import template | `structuredImportService.ts:187-211` | Direct XLSX write | R2, EXT |
| Structured zip staging/cleanup | `structuredImportService.ts:228-263,346-353` | Temp extraction/rm | R2/R3, A-K framework |
| Knowledge import PDF/temp | `knowledgeMapService.ts:220-235,318-395,403-486` | Direct final PDF copy plus temp rm | R3, A-K |
| Question-bank asset staging | `questionBankService.ts:110-181,281-453` | Copies directly to final batch tree before DB commit | R3, A-K |
| Question-bank batch trash | `questionBankService.ts:847-854` | DB commits before directory rename | R4, A-K |
| Import asset trash | `importBatchService.ts:119-157` | Rename or copy+unlink inside DB tx, no manifest | R4, A-K |
| PDF export | `pdfExportService.ts:219-241` | Hidden window print then direct write | R2, EXT |
| Window state | `main.ts:44-58,88-100` | Best-effort direct JSON write | R1, EXT |
| Widget state | `registerIpc.ts:191-215,253-269` | Best-effort direct JSON write | R1, EXT |
| Startup error log | `main.ts:117-126` | Direct temp log write | R1, EXT |

## External process, network, and UI side effects

| Surface | Inputs exposed/side effect | Evidence | Disposition |
| --- | --- | --- | --- |
| OCR | Each selected image path is passed to local Python/PaddleOCR; process timeout 180s | `ocrService.ts:24-74` | Future durable job + catalog; no DB write |
| Python environment check | Executes configured Python with import statement | `registerIpc.ts:401-409` | Future catalog, external process |
| DeepSeek structure | Sends OCR text to configured URL with API key | `deepseekService.ts:36-64,145-153` | Future network/privacy catalog |
| DeepSeek diagnosis | Sends question content, answer, wrong thinking, solution | `registerIpc.ts:388-398`, `deepseekService.ts:167-196` | Same |
| DeepSeek test | Sends `Hello` request with API key | `registerIpc.ts:412-433` | Same |
| TickTick AI | Sends goals or derived study/question aggregates | `ticktickAiService.ts:92-300` | Same |
| Shell open/reveal | Opens images, folders, PDFs, textbook URLs, question-bank PDFs | references in IPC UI table | Future operation catalog/UI intent |
| Native choosers | Select image, JSON, root, import packages, PDFs | `fileService.ts:40-64`, import/knowledge services | UI side effect; selected paths become untrusted input |
| Hidden PDF window | Loads generated data URL and calls `printToPDF` | `pdfExportService.ts:219-241` | Future export job/catalog |

## Questions-domain Phase A migration set

The migration gate treats these tables as question-owned: `questions`, `question_images`, `tags`, `question_tags`, `review_logs`, and `question_knowledge_points`. The following writers must be migrated before any future MCP question write is exposed:

| Writer class | Required entries | Evidence |
| --- | --- | --- |
| Direct Renderer IPC | create/update/delete/mark mastery/remove image/add review/submit review | `registerIpc.ts:284-288,295-296` |
| Legacy service functions | `migrateCategoryValues`, `createQuestion`, `updateQuestion`, `linkQuestionKnowledgePoints`, `deleteQuestion`, `removeImage`, `submitReviewResult`, `addReviewLog`, `markMastery` | `databaseService.ts:410-748` |
| Startup | category migration and rematch; seed path where it creates linkable knowledge/import records | `main.ts:144-165` |
| Structured import | batch creation, question/image creation, knowledge links | `structuredImportService.ts:289-343` |
| Question bank | add-to-mistakes question/images/links and cross-domain flags | `questionBankService.ts:740-798` |
| Import deletion | wrong-question batch delete and optional linked-question delete/assets | `importBatchService.ts:159-239` |
| Knowledge rematch/link | manual/startup rematch and direct link helper | `knowledgeMapService.ts:739-798`; `databaseService.ts:567-592` |
| Bridge/review | task-completion review, undo review, complete/uncomplete wrappers | `bridgeService.ts:11-55,162-195` |
| AI import metadata | batch/item relation for an existing question | `registerIpc.ts:435-448` |
| Global operations | JSON import, clear all, backup restore, root switch/database reopen | `databaseService.ts:967-1378`; `backupService.ts:121-145`; `registerIpc.ts:305-312` |
| Direct generic surfaces | mutable `getDatabase`, `runSql`, raw `db.run`, and `persistDatabase` reachable from the above | direct-persistence table |

Static acceptance must find no unallowlisted mutating statement naming a question-owned table and no call to a legacy writer outside `src/main/application/questions/**`. Read-only SQL joins/aggregates remain allowed with exact file/statement evidence.

## Read-only and deferred exceptions

- Pure question queries (`listQuestions`, `getQuestion`, `getQuestionsByIds`, dashboard/buckets/stats) may retain read-only repository access in Phase A.
- Knowledge queries that join question tables are read-only and deferred: `buildKnowledgeReviewStats`, `listKnowledgeTree`, review stats/questions, detail, and list-for-question (`knowledgeMapService.ts:85-125,498-643`).
- Question-bank list/get/stats/asset resolution and PDF opens are read-only or UI-only and deferred (`questionBankService.ts:505-679,801-819`).
- TickTick AI reads question/review aggregates but does not mutate local DB; it remains an explicit network side effect, not a question writer (`ticktickAiService.ts:92-300`).
- `getDeepSeekSettings` reads `app_settings`; saving is not read-only and is listed separately.
- Timer `getState`, widget `isOpen`, and window state load are read-only; timer commands are memory writes.
- File existence/path resolution is read-only; shell open/reveal is a UI side effect.
- Full migration of non-question domain writers is deferred, but Phase A kernel adoption still removes their ability to persist outside the coordinator.

## Current transaction and durability findings

1. The current whole-database persist is a direct overwrite with no temp, flush, integrity reopen, previous generation, or recovery matrix (`databaseService.ts:78-83`).
2. SQL transactions exist in only selected paths and do not include durable publication. A committed in-memory transaction can be followed by failed persistence.
3. File copies/deletes frequently occur inside a SQL transaction or before/after it without compensation. SQL rollback cannot restore those files.
4. Several cross-domain flows persist multiple times and can expose partial success: structured import, question-bank add-to-mistakes, and TickTick review bridge.
5. Several nominal reads mutate: all study reads through `ensureStudyBase`, `study:tasks:today`, study dashboard, TickTick tag list, and TickTick settings get.
6. `saveDeepSeekSettings` and `ai:recordImport` can report success without an immediate durable persist.
7. Restore and root switch replace database identity without epoch invalidation or a write fence.
8. The timer callback starts an unawaited DB write; errors are logged after timer state has advanced.

## Mechanical reconciliation checklist

Run this checklist whenever an IPC channel, exported service function, schema table, or persistence primitive changes:

1. Record `git status --short`; preserve unrelated/user-owned changes.
2. Count wrapped channels: `rg -c "handle\('" src/main/ipc/registerIpc.ts` (expected baseline 144).
3. Count direct listeners/handlers: `rg -c "ipcMain\.on\('" src/main/ipc/registerIpc.ts src/main/main.ts` (baseline 7 + 1) and `rg -c "ipcMain\.handle\('" ...` (baseline main 1).
4. Enumerate channel registrations: `rg -n "handle\('|ipcMain\.(on|handle)\('" src/main/ipc/registerIpc.ts src/main/main.ts`; diff names against all IPC tables above.
5. Enumerate exported service declarations: `rg -n "^export (async )?function|^export const|^export class" src/main/services`; classify every added/removed export as writer, mixed, external/UI, or read-only.
6. Reconcile per-service export-count baseline: backup 6, bridge 7, database 30, deepseek 4, file 5, focus engine 1, image 6, import batch 11, knowledge 11, OCR 4, path 5, PDF 3, question bank 11, structured import 6, study 22, TickTick AI 3, TickTick 30.
7. Search mutable DB access: `rg -n "getDatabase\(|persistDatabase\(|\.run\(|runSql\(|BEGIN|COMMIT|ROLLBACK" src/main` and classify every new match.
8. Search question-owned SQL: `rg -n -i "(insert into|update|delete from|alter table|drop table).*\b(questions|question_images|tags|question_tags|review_logs|question_knowledge_points)\b" src/main`.
9. Search filesystem mutations: `rg -n "fs\.(writeFile|copyFile|rename|unlink|rm|mkdir|cp)|XLSX\.writeFile|printToPDF" src/main`.
10. Search process/network/UI side effects: `rg -n "exec(File|Sync)?\(|fetch\(|shell\.(openPath|openExternal|showItemInFolder)|dialog\.show" src/main`.
11. Search timers/startup callbacks: `rg -n "setInterval|setTimeout|setSessionEndCallback|whenReady|before-quit|will-quit" src/main`.
12. For each write, inspect the complete call chain and record transaction boundary, persist point, file ordering, failure behavior, and caller. Do not infer completion from function names.
13. Run the Phase A static writer gate after it exists. Any new question writer fails until this inventory and the gate allowlist are updated with direct evidence.
14. Verify local references: every backticked repository path must exist; every cited line must still contain the claimed operation.

`rg` was unavailable in the current shell during this documentation task, so equivalent repository searches used the provided Grep tool (which is ripgrep-backed) and `git grep` for count reconciliation. Future environments with `rg` should run the commands exactly as written above.
