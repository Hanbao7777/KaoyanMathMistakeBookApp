# C11 Import Draft Write-Entry Inventory

## Evidence and scope

Inventory performed against accepted C10 commit `9ef76f3` and the C11 working
tree. C11 adds only the seven declared `imports.*` operations. External inputs
contain structured text and opaque managed asset IDs; they never contain an
arbitrary path, directory, archive extraction request, process command, model
credential, API key, or network target.

## Writer and cleanup inventory

| Area | Historical entry | C11 disposition |
| --- | --- | --- |
| Structured Excel/JSON/zip | `structuredImportService.prepare*`, `confirmStructuredImport` | File selection and parsing remain Renderer-local. Confirmation converts at most fifty valid rows into `application/imports`, stages referenced images into the managed inbox, and uses the same validate/apply path. C11 external contracts reject paths and never expose archive parsing. |
| Question bank import | `importQuestionBankZip`, `addExternalQuestionToMistakes` | Bulk bank loading remains unexposed. C11 declares `question_bank` provenance for bounded draft adapters; raw archives and bank deletion remain absent. |
| AI/OCR | `ocr:run`, `deepseek:structure`, former `ai:recordImport` | OCR remains local. DeepSeek receives OCR text only and the UI declares `deepseek_text_only`. The former direct batch writer is removed; AI output creates, stages, validates, previews, and applies one C11 draft. |
| Batch deletion | `importBatchService.deleteImportBatch`, `deleteExternalQuestionBatch` | Destructive batch deletion is explicitly excluded from C11 and remains unexposed for C13. |
| Temporary cleanup | structured zip extraction cleanup, import trash/quarantine | Existing operation-journal cleanup remains internal. C11 cancellation quarantines only assets under the managed import inbox. |
| Image binding | `questions.create`, question-bank image preparation, `images:choose` | External callers may bind only an opaque `assetId`. Renderer-selected images are hash-verified after managed copying; apply publishes question images through one operation manifest. |
| Renderer | `ImportPage`, `AiImportPage`, `QuestionForm` | C11 Renderer methods use `ipc/adapters/importsIpc.ts` and the fixed Renderer principal. `AiImportPage` no longer saves through `QuestionForm`. |
| IPC | `structuredImport:*`, `ocr:*`, `deepseek:*`, `questionBank:*`, `importBatches:*` | C11 registers `imports:*` handlers only through the Imports Renderer adapter. Legacy non-C11 operations remain inventoried and are not externally registered. |
| Startup | operation journal and job recovery | The data-root journal is recovered before Gateway readiness. C11 jobs use existing receipt/journal reconciliation and ambiguous outcomes remain fenced. |
| Timer/internal writers | no import timer; old cleanup and startup reconciliation only | No C11 timer, watcher, recursive inbox scan, autonomous network request, or startup import admission exists. |

## State and recovery contract

The versioned state machine is `collecting -> validated -> applied` or
`collecting|validated -> cancelled`. Adding an image invalidates prior
validation. Validation and preview use canonical hashes and stable item ordering.
Apply rechecks the validated preview binding, deduplicates against the draft and
stored questions, and is idempotent through the Gateway receipt. Image creation
and cancellation cleanup use `OperationManifestStore`; a post-commit publication
failure fences the coordinator and startup reconciles validated manifests.

Managed image selection rejects UNC/device/network paths, absolute paths supplied
by external operations, unsupported extensions, oversized files, symbolic links,
reparse/realpath escapes, changed file identities, and hash/size mismatches. The
managed inbox is never enumerated or returned to an external principal.

## Exact external set

- `imports.create_draft`
- `imports.add_draft_image`
- `imports.validate_draft`
- `imports.preview_draft`
- `imports.apply_draft`
- `imports.get`
- `imports.cancel`

`kaoyan://imports/{draftId}` is the owner-bound resource view backed by
`imports.get`. There is no generic import, filesystem, OCR, DeepSeek, archive,
database replacement, batch deletion, or cleanup tool.
