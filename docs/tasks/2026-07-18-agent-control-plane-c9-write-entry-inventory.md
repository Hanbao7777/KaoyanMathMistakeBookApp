# C9 Knowledge, Textbooks, and Analytics Write-Entry Inventory

## Scope and reconciliation

This inventory is the C9 migration evidence for the bounded knowledge/textbook/analytics wave. It was reconciled against `src/main/ipc/registerIpc.ts`, `src/main/main.ts`, `src/main/services/knowledgeMapService.ts`, `src/main/services/databaseService.ts`, and the application/Gateway registration on 2026-07-18. It does not amend the historical Phase A inventory.

| Entry | Trigger | Effects | C9 disposition |
| --- | --- | --- | --- |
| `knowledgeMap:importZip` | Renderer chooser | ZIP extraction, textbook PDF copy, textbooks/knowledge/import batch rows | Local-only import; not cataloged or MCP registered. |
| `knowledgeMap:bindTextbookPdf` | Renderer chooser | Stores an externally selected PDF path in `textbooks` | Local-only physical-file association; not external. C9 external `knowledge.bind_textbook` changes only an existing node-to-textbook database relation. |
| `knowledgeMap:rematch` | Renderer | Computes and inserts question-knowledge links | Internal bounded question command path; not external. |
| `seedImportKnowledgeMap` | startup empty-map seed | Extracts bundled seed and writes textbook/knowledge/import rows | Internal startup path only; not external. |
| `importKnowledgeMapZip` | Renderer import | Same as import ZIP | Local-only import; not external. |
| `persistKnowledgeImport` | import/seed helper | Coordinator-scoped textbook, knowledge, import-batch mutations | Retained as local import implementation; no Gateway registration. |
| `rematchKnowledgePoints` | renderer/startup | Delegates link mutations to `questions.rematch_knowledge` | Existing application/coordinator path; no C9 MCP exposure. |
| `knowledge.link_question` | Renderer/MCP application command | Inserts one `question_knowledge_points` relation | `src/main/application/knowledge/commands.ts`; Gateway-only for MCP, coordinator business write, idempotent receipt/audit. |
| `knowledge.unlink_question` | Renderer/MCP application command | Deletes one `question_knowledge_points` relation | Same application/Gateway/coordinator path; semantic no-op is revision-neutral. |
| `knowledge.bind_textbook` | Renderer/MCP application command | Updates one `knowledge_points.textbook_id` relation | Same path; accepts existing database ID only and never a path or file payload. |
| `knowledgeMap:listTree`, `getDetail`, `listForQuestion`, review stats/queries | Renderer | Database reads | C9 external equivalents use bounded application queries. Legacy renderer reads remain read-only. |
| `textbooks.list/get` | C9 application/MCP | Database metadata reads | Application query redacts `file_path`; no textbook bytes or physical mutations are exposed. |
| `analytics.get_weak_areas` | C9 application/MCP | Derived knowledge/question aggregate read | Bounded application query with no write side effects. |
| `knowledge:*`, `textbooks:*`, `analytics:getWeakAreas` | Typed Renderer IPC | Fixed DTO calls through the Renderer principal and `AgentGateway` | Exact C9 Renderer/external parity surface. No caller-selected identity, catalog, SQL, path, or persistence access. |

## Exact external set

Reads: `knowledge.list_nodes`, `knowledge.get_node`, `knowledge.list_links`, `textbooks.list`, `textbooks.get`, `analytics.get_weak_areas`.

Writes: `knowledge.link_question`, `knowledge.unlink_question`, `knowledge.bind_textbook`.

The MCP manifest is the executable source of truth. Import, seed, rematch-all, arbitrary graph SQL, PDF open/bind-by-path, and physical textbook-file mutation are intentionally absent.

`knowledgeMap:listTree`, `knowledgeMap:listForQuestion`, review-stat channels, PDF open, and PDF chooser binding remain preserved local channels because they construct trees, return question/PDF status shapes, or initiate UI/filesystem effects that do not match the C9 public DTOs. The typed C9 IPC surface above provides Renderer parity for all exact external operations without broadening those local-only channels.

## Static gate expectations

- `knowledgeMapService.ts` may retain local import/seed/rematch/PDF chooser code, but C9 external operations must not call it.
- `src/main/application/knowledge/**` is the only C9 application writer location for `question_knowledge_points` and `knowledge_points.textbook_id`.
- MCP registry/result mapping imports no persistence, services, SQL, coordinator, or Gateway implementation.
- `mcpExternalExposureManifest.businessOperations` contains exactly the prior C6 set plus the nine C9 operations, with no import/seed/rematch/path operation.
