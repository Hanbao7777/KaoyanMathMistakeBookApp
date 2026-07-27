# C12 TickTick Write-Entry Inventory

## Evidence and boundary

Inventory performed against the accepted C11 baseline `e516487` and the partial
C12 working-tree edits. C12 adds exactly nine bounded operations for the local
TickTick-style domain. The application stores no TickTick credential, remote URL,
token, process command, or arbitrary API request. The declared bridge operation
updates a local link; cross-domain bridge synchronization remains an internal
application concern and is never exposed as a generic remote operation.

## Exact external set

- `ticktick.lists.list`
- `ticktick.lists.create`
- `ticktick.lists.update`
- `ticktick.habits.list`
- `ticktick.habits.create`
- `ticktick.habits.update`
- `ticktick.calendar.list_events`
- `ticktick.bridges.get`
- `ticktick.bridges.update`

MCP registers these operations explicitly as Gateway tools. There is no generic
`execute`, remote URL, settings-secret, DeepSeek-credential, process-launch, or
arbitrary remote-API tool/resource.

## Writer inventory

| Area | Entry points | C12 disposition |
| --- | --- | --- |
| Lists | `TickTickSidebar`, task/list pages, `ticktick:lists:*` | List, create, and update use `ticktickIpc` -> Renderer principal -> Gateway -> `application/ticktick`. Delete and reorder remain local-only legacy UI operations and are not exposed by C12. |
| Habits | habits page, `ticktick:habits:list/create/update` | List, create, and update use the same application/Gateway path. Delete, toggle, and log history remain local-only and unexposed. |
| Calendar | calendar page, `ticktick:calendar:month` | Month reads use the application query and a bounded year/month contract. No external calendar provider or arbitrary date-range query exists. |
| Bridges | task detail, review/mastery sync, `ticktick:bridge:*` | `bridges.get/update` use the application/Gateway path. Linked review/mastery synchronization is internal and retains its explicit command/compensation helpers; bridge delete and reverse linked lookup are local-only and unexposed. |
| Settings/secrets | `get/saveTickTickSettings`, white-noise settings, DeepSeek settings | Excluded. Settings values and all model credentials stay behind local IPC; none are in C12 contracts, catalog, scopes, or MCP resources. |
| Timer | `FocusTimerEngine`, `timer:*`, focus session callback | Excluded from C12. Timer persistence remains a local focus-session path and is not a calendar or remote network writer. |
| Startup | `initializeTickTickService`, default settings/tag cleanup, agent/database recovery | Inventory only. Startup performs local schema/settings cleanup before Gateway readiness; it creates no external admission and no network request. |
| AI | `ticktickAiService` decomposition, daily plan, review, `deepseekService` | Excluded. AI receives only the existing explicit local/model inputs and cannot create a C12 object except through existing local application calls; secrets and arbitrary network operations are not C12 capabilities. |
| Network | no TickTick network adapter or remote API writer exists | No network writer is registered. C12 records `remoteOutcome: not_requested` for the local-only declared operations. Adding a provider would require a later bounded contract, scope, journal, and compensation gate. |
| Cross-domain bridge sync | `bridgeService.syncTaskCompletedToReview`, `syncReviewToTickTickTask`, `syncMasteryToTaskPriority`, auto-review task generation | Internal-only. Local and linked-domain outcomes are separate phases; review mutations use question application commands, and multi-step failures restore the completed side or report explicit compensation failure. These functions are not MCP operations. |

## Local/remote outcome and recovery contract

Each declared write has one durable local database outcome governed by
`DatabaseCoordinator`, Gateway idempotency, data revision, audit, and exact
receipt replay. No remote side effect is requested, so the remote outcome is
explicitly `not_requested`; a lost response replays the exact local receipt and
never retries a different payload. Internal bridge synchronization records local
and linked-domain phases separately through coordinator writes and compensates
the already-applied side in reverse order. If compensation fails, the operation
reports the causal error plus compensation failure and does not claim success.

Queries are fenced during recovery or concurrent writes, lists are bounded by
the MCP policy pagination limits, and outputs contain no settings secrets,
credentials, absolute paths, or raw network configuration.

## Static and parity gates

- Renderer adapters contain fixed operation constructors and only the fixed
  Renderer principal; they do not import services, persistence, or SQL.
- `registerIpc` routes the nine declared channels through the adapter boundary;
  excluded legacy channels remain explicitly absent from the C12 manifest.
- Catalog, scopes, exposure manifest, MCP registry, schemas, and result mapping
  must agree on exactly the nine C12 names.
- Application tests compare Renderer service results with application/Gateway
  results for list, habit, calendar, bridge, idempotent replay, revision, and
  validation behavior.
- Static tests reject service/SQL bypasses in the C12 adapter and reject generic
  external execution or network/credential fields in C12 contracts.
