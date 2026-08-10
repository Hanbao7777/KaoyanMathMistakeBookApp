# C13 Global R4 Writer Inventory

## Scope

This inventory records the C12 `eb78c55` write and read entry points that C13
migrates. It is deliberately limited to the ten declared global operations.
It does not authorize a generic filesystem, database-file, or operation
executor surface.

## External Operations

| Operation | Existing seam | C13 disposition |
| --- | --- | --- |
| `backups.list` | `backupService.listDatabaseBackups` | Bounded Gateway query; returns metadata only, never an absolute path. |
| `backups.create` | `backupService.createDatabaseBackupMaintained` | Durable Gateway job with an App-selected backup target. |
| `exports.create` | `pdfExportService.exportQuestionsToPdf` | Durable Gateway job with a bounded export specification and App-selected export root. |
| `exports.get` | export result metadata | Owner-bound Gateway query/resource; never opens or returns a raw path. |
| `backups.delete` | `backupService.deleteDatabaseBackup` | Implemented R4 Gateway command; resolves an owner-bound published managed backup by opaque identifier and durably quarantines verified evidence. |
| `database.restore` | `backupService.restoreDatabaseBackup`, `databaseService.restoreDatabaseFromFile` | Implemented R4 Gateway command; resolves an owner-bound published managed backup by opaque identifier, validates evidence/schema before live mutation, publishes through the database replacement coordinator, and reconstructs terminal receipt state from a private restore journal after restart. |
| `database.replace_from_import` | `databaseService.importData` | Implemented R4 Gateway command; accepts only an opaque owner-bound published `database_import` asset, validates an exact bounded full-data package, preserves the live control plane, consumes the package once, and reconstructs terminal receipt state from a private import journal after restart. |
| `database.clear_all` | `databaseService.clearAllData` | Implemented R4 Gateway command; binds the exact bounded business-row and verified managed-image inventory, clears only the explicit business allowlist through the replacement coordinator, and reconstructs terminal receipt state from a private clear journal. |
| `imports.delete_batch` | `importBatchService.deleteImportBatch` | Implemented R4 Gateway command; owner-binds the batch, resolves every mutable or preserved dependency plus managed-file binding into the authorization surface, including exact bounded shared-reference rows and per-file reference hashes, rejects the full inventory above 500, and reconstructs terminal state from exact private and semantic journals. |
| `data_root.migrate` | `databaseService.switchDataRoot`, `pathService.stageDataRootSwitch` | R4 Gateway command; accepts a local-user-selected root token only, then binds copy/hash/free-space evidence. |

## Writer Inventory

| Writer / caller class | Current seam | C13 migration requirement |
| --- | --- | --- |
| Renderer settings IPC | `registerIpc.ts`: export/import/clear/root handlers | Replace declared global operations with the local Renderer Gateway adapter. File chooser remains a local-only authority issuer. |
| Renderer backup IPC | `registerIpc.ts`: Gateway adapter for create/list; local restore/delete remain excluded R4 paths | Backup create/list use the fixed local Renderer Gateway adapter. Folder-open, restore, and delete remain local UI paths until R4 migration. |
| Renderer PDF export IPC | `registerIpc.ts`: Gateway adapter for create/get; local open remains separate | Export create/get use the fixed local Renderer Gateway adapter. Folder-open remains local UI only. |
| Startup auto-backup | `backupService.ensureDailyAutoBackup` | Retain as an internal scheduled maintenance path; never expose it as a client-selectable operation. |
| Database identity replacement | `databaseService.replaceDatabaseIdentity` | Execute only behind a C13 application handler with a prewritten external recovery manifest. |
| Full-data import package staging | `globalApplication.stageSelectedDatabaseImport` | Backend local-selection boundary only; validates and durably copies a bounded full-data JSON package into the managed import root before publishing an opaque owner-bound asset. It is not an MCP/Gateway raw-path surface. |
| Full-data clear | `globalApplication.execute` -> `replaceManagedDatabaseClear` | Backend R4 plus one-operation change-set boundary only; repeats the exact row/file resolution under maintenance, publishes a consistency package, optionally quarantines only verified App-owned image evidence, and preserves all control-plane tables. |
| Data-root publication | `pathService.publishDataRootSwitch` | Execute only after C13 plan verification; retain old root until journal completion. |
| Import batch deletion | `importBatchService.deleteImportBatch` | Implemented through the global application/replacement coordinator with exact owner, row, file, recovery-package, R4 reservation, and terminal-receipt bindings; preserved dependencies count toward the same 500-entry limit. |

## Required C13 Boundaries

- MCP tools are explicitly registered from the exact ten-operation manifest.
- External payloads identify managed assets by opaque IDs or bounded names; they
  never carry a database file path, export path, filesystem path, or root path.
- R4 planning resolves affected assets, recovery package/hash, data version,
  catalog identity, and available/required disk before the local-user approval.
- Consumption repeats resolution and compares every binding before it reserves
  and consumes the one-use R4 authorization.
- Any journal, candidate-recovery, publication, or receipt ambiguity fences
  writes and is replayed only from authoritative receipt evidence.
- Full-data import packages use the exact `kaoyan-full-data-v1` table/column
  contract with byte, row, and scalar bounds. Consumption is terminal and
  single-use; package, private-journal, terminal-journal, and same-version live
  semantic evidence are revalidated during restart recovery.
