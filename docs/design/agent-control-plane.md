# Kaoyan Agent Control Plane 架构设计

> 状态：提案
>
> 目标版本：V2.x 平台增强
>
> 文档目的：把考研数学错题本建设为一个本地优先、可由外部 AI 智能体深度理解和控制的个人备考系统。MCP 是首个标准接入协议，但不是系统内部唯一边界。

## 1. 产品方向

本项目不再把 AI 仅仅理解为 App 内的若干固定按钮，也不计划在 Electron 内复制一个完整聊天产品。目标形态是：

- App 是可靠的数据与执行系统，负责错题、复习、知识点、题库、任务、专注、习惯、学习监督和本地文件。
- Codex、Claude 等外部 AI 是可替换的智能决策层，负责理解目标、跨模块分析、制定计划和调用 App。
- Agent Control Plane 是两者之间的正式控制层，负责业务契约、权限、审批、事务、审计、并发、作业和兼容性。
- MCP 是外部 AI 访问控制层的标准协议入口；未来可以增加 CLI、自动化或其他本地协议而不重写业务能力。

产品定位由“带少量 AI 功能的错题本”升级为：

> 本地优先、由外部智能体协作控制的个人备考操作系统。

### 1.1 高权限 AI 原则

本设计不以限制 AI 能力为目标。正式产品应让用户能够主动授予 AI 较高乃至接近完整的控制权限，从而实现真正的跨模块规划和自动执行。

权限系统的职责是让高权限变得可理解、可选择、可撤销、可追踪，而不是把所有智能体永久限制在只读模式。具体原则如下：

1. 能力面完整：AI 可以读取、创建、更新、组织、执行和自动化主要业务对象。
2. 用户拥有最终决定权：用户可以为可信客户端开启长期高信任模式，也可以随时降权或断开。
3. 风险和权限分离：操作具有客观风险等级，客户端具有用户授予的信任等级；两者共同决定是否自动执行。
4. 可恢复优先于频繁打断：对于能够通过版本、备份、事务或撤销可靠恢复的操作，高信任模式可以自动执行。
5. 少数安全底线不可绕过：清空全部数据、恢复数据库、迁移真实数据目录等破坏半径极大的操作，即使在最高信任模式下也必须生成恢复点并满足额外保护条件。
6. AI 能力与模型供应商解耦：不要求用户使用 DeepSeek、OpenAI 或任何固定模型。

## 2. 现状与约束

### 2.1 可复用基础

项目已经拥有较宽的业务面：

- 错题 CRUD、图片、标签和掌握度。
- 间隔复习、复习历史、薄弱项和统计。
- 知识地图、教材绑定和知识点复习。
- 外部题库、作答记录和加入错题本。
- 学习监督、资料进度、学习任务、学习会话和日复盘。
- TickTick 风格清单、任务、专注、习惯、日历和桥接同步。
- 备份、恢复、结构化导入和 PDF 导出。
- OCR、DeepSeek 结构化、错因诊断和计划生成等 Beta AI 能力。

`src/shared/api.ts` 已描述 Renderer 可访问的业务 API，`src/main/ipc/registerIpc.ts` 已注册 140 余个 IPC 通道，主进程服务层拥有可测试的业务实现。这些能力可以作为控制层建设的起点，但不应被原样复制为 MCP 工具。

### 2.2 核心技术约束

1. 数据库使用 `sql.js`，主进程持有内存数据库，并通过整库导出写盘。
2. 外部 MCP 进程不得直接打开或写入同一数据库文件，否则可能覆盖 App 中尚未持久化的内存状态。
3. Electron 主进程必须继续成为数据库和本地业务状态的唯一所有者。
4. Renderer、IPC、MCP 和未来自动化入口必须复用同一套业务规则。
5. 项目仍缺少完整 Renderer/Electron 端到端测试，控制层建设必须同步补齐关键 E2E。
6. 本地优先不等于模型调用完全本地：当外部云端 AI 读取数据时，相应数据会离开本机，必须让用户明确知道共享范围。

## 3. 总体架构

```text
Codex / Claude / other MCP clients
                 │
       ┌─────────┴─────────┐
       │                   │
   stdio launcher     Streamable HTTP
       │                   │
       └─────────┬─────────┘
                 ▼
       Kaoyan Agent Gateway
  auth / policy / audit / jobs / idempotency
                 │
                 ▼
      Application Command & Query Bus
                 │
       ┌─────────┴─────────┐
       │                   │
 Renderer IPC adapter   Domain services
       │                   │
       └─────────┬─────────┘
                 ▼
       Database Coordinator
                 │
                 ▼
       single in-memory sql.js DB
```

### 3.1 分层职责

#### Domain Services

保留并逐步拆分现有业务服务。领域服务实现业务规则，不感知 MCP、HTTP、审批 UI 或具体模型。

#### Application Command & Query Bus

定义稳定的应用用例，是 Renderer IPC 和 MCP 的共同入口：

```ts
executeCommand<T>(command: AppCommand, context: ExecutionContext): Promise<CommandResult<T>>
executeQuery<T>(query: AppQuery, context: ExecutionContext): Promise<QueryResult<T>>
```

`ExecutionContext` 至少包含：

- `requestId`
- `clientId`
- `source`: `renderer | mcp | internal`
- `permissionProfile`
- `expectedRevision`
- `approvalToken`
- `traceId`

#### Database Coordinator

所有数据库写命令通过单一写入队列执行：

- 串行化写命令。
- 使用数据库事务包裹一个业务命令的数据库部分。
- 命令成功后统一持久化。
- 写盘使用临时文件和原子替换策略。
- 维护 `{ dataEpoch, dataRevision }` 并支持乐观并发校验。
- 数据库事务失败时回滚；涉及文件系统的命令还必须遵循第 3.2 节的持久操作协议。
- 高风险批量操作执行前创建恢复点。

#### Agent Gateway

外部智能体的唯一业务入口，负责：

- 输入和输出 Schema 校验。
- 客户端身份及权限判断。
- 风险策略和审批判断。
- 请求幂等及重复提交防护。
- 写入准入和并发冲突预检。
- 审计记录和领域事件发布。
- 分页、限流、大小限制和敏感字段过滤。
- 统一错误码及可重试语义。
- 持久作业和变更集管理。

Gateway 与 Database Coordinator 的职责边界固定为：

```text
transport → gateway authentication → schema validation → policy/risk
          → coordinator control-write admission/reservation
          → command/query bus
          → database coordinator one transaction: domain mutation + dataRevision
            + execution receipt + terminal idempotency + required audit
          → atomic publish → domain events → result/replay
```

Gateway 不实现第二套写入队列；Database Coordinator 是数据库串行化、事务、持久化和修订号的唯一所有者。

##### Phase B Gateway Module and authentication Seam

Phase B places one deep `AgentGateway` Module at the application-admission seam. Its Interface is deliberately only:

```ts
interface AgentGateway {
  execute(commandEnvelope: AgentCommandEnvelope, principal: AgentPrincipal): Promise<AgentExecuteOutcome>;
  query(queryEnvelope: AgentQueryEnvelope, principal: AgentPrincipal): Promise<AgentQueryOutcome>;
}
```

The caller supplies a validated, unforgeable `AgentPrincipal`, never a bearer token, signature, public key, or pairing secret. `AgentGateway` owns catalog lookup, runtime schema validation, descriptor-bounded policy/risk resolution, approval/change-set workflow routing, idempotency admission and replay, redaction/pagination, conversion to a trusted application `ExecutionContext`, audit admission/result records, and stable error outcomes. It calls the existing Command Bus or Query Bus exactly once per admitted operation. Preview, approval, apply, audit search, revoke, and policy inspection are workflow commands or queries in these two methods; they are not extra Gateway methods and do not create shallow pass-through Modules.

`ClientAuthenticator` is a separate deep Module at the credential-to-principal seam:

```ts
interface ClientAuthenticator {
  authenticate(credentials: RawClientCredentials): Promise<AgentPrincipal>;
}
```

It consumes raw credentials, validates their transport-specific proof, checks enablement/revocation/session conditions, loads the client registry record, and issues an immutable principal containing `clientId`, display identity, granted scopes, trust profile, credential binding/fingerprint, and authentication time. The Gateway cannot construct a privileged principal and never consumes raw OAuth tokens or signatures. Phase B has a renderer Adapter (trusted first-party, no pairing/OAuth) and a test Adapter. Phase C adds HTTP OAuth and stdio public-key Adapters at this same seam without changing `AgentGateway`.

The Renderer is a trusted first-party Adapter, not a second policy or persistence path. Once a domain is migrated, its Renderer writes and external writes enter the same Gateway with different principals; both share the catalog, schemas, idempotency, revision checks, risk decisions, recovery protocol, audit ledger, and error mapping. Renderer identity grants only local-first-party authority and does not imply that arbitrary renderer payloads can select a client, trust profile, or policy.

The internal implementation may use local-substitutable seams for clock, canonical hashing, registry persistence, policy persistence, durable ledger storage, and event observation. Those are internal seams, not additional caller Interfaces. This gives callers leverage from two Gateway operations while keeping policy, authentication, and durability knowledge local.

##### Execution receipt, revision, and audit protocol

`DatabaseCoordinator` remains the single physical writer queue. Phase B adds two internal execution modes at its seam, neither callable by `AgentGateway`: `executeBusinessWrite` and `executeControlWrite`. Both take the same coordinator admission/serialization/transaction/atomic-publish path. `executeBusinessWrite` is the existing application-write mode: it may change domain rows and increments `dataRevision` exactly once only when the domain mutation reports a semantic change. `executeControlWrite` may change only control-plane rows and increments a distinct `controlRevision` exactly once when changed; it never changes `dataEpoch` or `dataRevision`, so policy, audit, idempotency, and query records cannot invalidate a caller's expected business version.

`control_metadata` stores non-negative `control_revision` beside epoch/data revision. It is a diagnostic/control concurrency token, not a substitute for the caller-facing `DataVersion`. Internally, persistence validates a `DatabaseGeneration = { dataEpoch, dataRevision, controlRevision }`: same-epoch candidate recovery orders first by `dataRevision` and then by `controlRevision`, while cross-epoch selection still requires committed epoch-transition evidence. A control write increments only `controlRevision`; a Gateway business transaction that changes domain rows and atomically terminalizes a receipt increments `dataRevision` and `controlRevision` once each. An ordinary internal business write without control-plane changes increments only `dataRevision`. This makes a control-only publication, and a semantic business no-op with a terminal receipt, distinguishable from its admitted predecessor after a crash. Atomic publication, candidate inspection, expected-generation verification, and startup recovery all use the full internal generation.

The coordinator owns both increment capabilities and rejects a business-mode operation that mutates only control tables or a control-mode operation that mutates domain tables. Both modes publish the complete `sql.js` image durably before returning. This is one queue and one physical database owner, not a second queue or a Gateway database path.

`CommandBus` gains an internal `executeWithExecutionReceipt` seam used only by the Gateway implementation after control admission. Its caller Interface remains `execute`; the receipt seam is an implementation capability injected at composition and unavailable to Renderer adapters or transports. In the coordinator's *same SQL transaction*, after the handler's domain mutation and before `COMMIT`, the hook: validates the admitted receipt and any R4 reservation; increments `dataRevision` at most once; writes the immutable terminal execution receipt/idempotency outcome; consumes the R4 reservation when applicable; and appends the required terminal audit record/hash. The receipt hook failure rolls back the domain mutation and returns no success. The existing atomic publisher then makes that one image durable; only after verified live-file reopen may Command Bus publish domain events and Gateway return the outcome.

Control admission is a separate, serialized `executeControlWrite`: it inserts or reads a canonical `{ clientId, requestId }` receipt, detects a different payload hash conflict, and records an `admitted` audit event. It creates a pending workflow or atomically reserves an R4 grant when required. It does not claim execution success. Queries and denials use `executeControlWrite` to append their auditable record and may return only after that write is durably published. If required audit materialization fails, a denial/query returns `AUDIT_UNAVAILABLE`; a business command rolls back before commit. There is no best-effort post-command audit gap.

Crash recovery examines the Phase A selected live candidate before reopening external writes. A selected candidate containing a terminal receipt contains the matching domain result, R4 consumption, and terminal audit record by the same transaction. A selected candidate containing only `admitted`/`reserved` proves no business transaction committed in that candidate; recovery writes one control-mode `interrupted_precommit` receipt/audit record and releases its reservation. Candidate ambiguity remains a Phase A recovery fence; no retry or result is returned until it is resolved. A crash after durable publication but before the response is replayed from the terminal receipt, never re-executed. This replaces any outbox for required audit/receipt materialization; domain-event notification remains post-publish and is not a success condition.

#### Transport Adapters

传输层只处理协议和连接生命周期，不包含业务逻辑。首期提供 App 内 Streamable HTTP 与独立 stdio launcher 两个入口。

### 3.2 数据库与文件副作用的持久操作协议

数据库事务不能原子覆盖图片、教材、导入目录、备份和数据根目录等文件系统副作用。因此“事务成功”只代表数据库状态原子提交；所有跨数据库与文件系统的命令使用可恢复的 operation journal：

```text
prepared → files_staged → db_committed → files_committed → completed
    └──────────────→ compensating → compensated / needs_recovery
```

规则如下：

1. 在当前数据根目录同一卷的受控 staging 目录准备新增或替换文件，避免跨卷 rename 被误认为原子操作。
2. 执行前写入外部持久 operation manifest；R4 操作的 manifest 存放在不会被数据库恢复覆盖的 App `userData` 恢复目录。
3. manifest 记录操作类型、客户端、幂等键、输入哈希、原路径、staging 路径、目标路径、内容哈希、数据库 epoch/revision 和补偿策略。
4. 每次状态转换使用临时文件、flush 和同目录原子替换发布；状态转换本身可重复执行。
5. 物理删除默认改为移动到受管理 quarantine/trash，数据库提交成功后才进入保留期；保留期结束后再清理。
6. App 启动时在接受 MCP 写请求前扫描未完成 manifest，并按操作类型继续提交、执行补偿或标记 `needs_recovery`。
7. 无法自动判断安全结果时停止相关领域写入，在控制中心展示人工恢复步骤，不能报告成功。
8. 每种跨资源命令必须有故障注入测试，覆盖 staging 前后、数据库提交前后、文件提交前后和进程崩溃重启。

R4 恢复保护不是单一 `.db` 复制，而是“一致性恢复包”或等价的可逆迁移计划：

| 操作 | 必需恢复资产 | 恢复/补偿顺序 |
| --- | --- | --- |
| 删除错题并删除图片 | 修改前实体快照、图片 quarantine 清单及哈希 | 恢复文件，再恢复数据库关系 |
| 清空全部数据 | 数据库快照、受影响图片/教材/导入资产 manifest，必要时完整文件快照 | 校验恢复包后恢复文件和数据库，最后切换 epoch |
| 恢复数据库 | 当前数据库一致性快照、当前 managed-files manifest、目标备份引用校验报告 | 先保留当前恢复包，再替换数据库，校验引用，最后切换 epoch |
| 数据根目录迁移 | 旧根目录 manifest、新根目录 staging、逐文件哈希和旧配置 | 完整复制与校验后原子切换配置；旧根目录保留到验收/保留期结束 |
| 删除导入批次及资产 | 数据库实体快照、资产 quarantine manifest | 文件可恢复后提交数据库；失败则按 journal 对账 |

若磁盘空间不足以创建所需恢复资产，R4 命令必须拒绝执行或由用户明确选择一个文档化的降级路径；不能把“已创建数据库备份”等同于“全部数据可恢复”。

### 3.3 数据库耐久写入算法

普通数据库提交的持久化顺序固定为：

1. 在内存数据库事务中执行命令并递增 revision。
2. 导出数据库字节并写入数据库同目录的唯一临时文件。
3. flush 文件内容并在平台支持时 flush 父目录元数据。
4. 重新打开临时数据库并执行最小完整性校验。
5. 将当前数据库改名为单代 previous 文件，再将临时文件原子替换为 live 文件；Windows 下使用经过实际打包验证的 replace/retry 策略。
6. 重新打开 live 文件验证 epoch/revision；成功后清理 previous，失败则恢复 previous 并进入只读恢复状态。
7. 只有 live 文件验证成功后才发布领域事件和成功响应。

启动恢复矩阵必须处理 live、temp、previous 任意组合：选择 epoch/revision 最新且通过完整性校验的候选，无法唯一判断时不自动写入，并在控制中心请求恢复。测试需要在 export、temp write、flush、replace、reopen 各阶段提供确定性故障注入 seam。

## 4. 运行与进程模型

### 4.1 App 内 MCP 服务

Electron 主进程在启用外部控制后启动 MCP Streamable HTTP 服务：

- 只监听 `127.0.0.1`。
- 使用动态端口或可检测的保留端口区间。
- 将当前端口、进程 ID、App 实例 ID、启动时间和协议版本原子写入 discovery 文件。
- discovery 文件不含任何长期或临时认证秘密；仅凭该文件不能完成认证。
- 验证 `Origin`，拒绝非预期来源。
- `/mcp` 不接受 discovery 信息、裸 `clientId` 或长期配对凭据直接作为授权；直接 HTTP 客户端必须完成下述 OAuth 会话签发流程。
- App 退出时关闭服务并使会话失效。
- 发布 discovery 前服务必须已经监听并能够完成认证握手；退出或启动失败时安全清理属于本实例的 discovery。

直接 Streamable HTTP 客户端使用本地 MCP OAuth 2.1 路径：

1. App 同时作为本地 authorization server 和 MCP protected resource，发布受保护资源元数据与授权服务器元数据。
2. 客户端使用 Authorization Code + PKCE，并在 authorization/token 请求中携带指向当前 MCP endpoint 的 `resource`；不支持 PKCE 或 resource audience binding 的客户端不得直接连接 HTTP，可改用 stdio launcher。
3. 授权请求通过一次性 state/nonce 唤起或聚焦 App 内控制中心，展示已验证客户端信息、redirect URI、请求 Scope、信任模式和数据共享提示；用户批准后才创建/更新 `clientId` 授权记录。
4. access token 短期有效，绑定 `clientId`、Scope、MCP resource audience、当前 `appInstanceId` 和 token ID；服务端校验签名、audience、实例、过期、撤权时间和 token denylist。
5. refresh token 只发给允许长期连接的已配对客户端，采用 rotation 和 reuse detection；每次使用后旧 refresh token 立即失效，重放会撤销整个 token family 并记录审计。
6. HTTP access token 只用于建立当前 App 实例的 MCP session；后续请求同时校验 bearer token、`Mcp-Session-Id` 所属 `clientId` 和协议版本，不能把一个客户端的 session 与另一个 token 混用。
7. App 重启使旧 access token 和 MCP session 因 `appInstanceId` 变化而失效；合法客户端使用仍有效的 rotated refresh family 获取新实例 token，或重新授权。
8. 用户撤销客户端、降低 Scope、关闭外部控制或触发紧急停止时，相关 access token、refresh family 和 session 立即失效，不等待自然过期。
9. 授权码、access token、refresh token、PKCE verifier 和 session ID 不写入 discovery、普通日志或业务数据库明文字段；客户端侧使用系统安全存储。
10. 验收覆盖授权码重放、PKCE 不匹配、错误 resource/audience、错误 Origin、过期 token、refresh reuse、跨客户端 session 混用、App 重启、Scope 降级和即时撤权。

### 4.2 stdio launcher

随安装包提供 `kaoyan-mcp`：

1. 由 MCP 客户端作为子进程启动，并携带该配对客户端自己的 `clientId`。
2. 读取 discovery，验证文件所有者/ACL、格式、过期时间、PID 存活和 App 实例握手；畸形或陈旧文件一律视为不可信。
3. App 未运行时，launcher 获取当前用户级启动锁，只有锁持有者启动 App；其他 launcher 等待 readiness，避免并发启动竞态。
4. App 根据用户设置以前台、最小化或 `agent-startup` 模式启动；只有在本次由 launcher 启动且无 UI/作业/其他客户端依赖时，才允许按配置随最后连接退出。
5. launcher 使用配对时生成的客户端密钥，对 App 发出的随机 challenge 签名；App 验证 `clientId`、公钥、撤销状态和 Scope 后签发短期、单会话、绑定 App 实例的 session token。
6. Windows 首选不可导出的 CNG/系统凭据存储密钥；兼容回退使用 DPAPI 保护的每客户端密钥，并在文档中明确同一 OS 用户已完全失陷不属于可防御边界。
7. 每个转发请求携带已验证的客户端身份和 session，不能由请求参数自行声明身份。
8. 将 stdio MCP 消息转发至 App 内服务；重连后必须重新完成 challenge，不复用旧 App 实例的 session。
9. 所有日志只写 `stderr`，保证 `stdout` 仅包含合法 MCP 消息。
10. App 升级或端口变化时自动重新发现，但不会静默扩大权限。

安全验收至少证明：只读取 discovery 的未配对进程无法调用任何工具；复制旧 session、使用已撤销客户端、篡改 PID/端口或重放 challenge 均被拒绝。基础威胁边界是“当前 OS 用户账户及 App 安装未被完全攻陷”，不宣称能抵御拥有同一用户任意代码执行和凭据访问能力的恶意软件。

### 4.3 单实例与多客户端

- 继续使用 Electron 单实例锁。
- 允许多个只读客户端并发连接。
- 所有写操作由 Database Coordinator 串行执行。
- 使用数据修订号避免不同客户端基于过期状态覆盖更新。
- 客户端令牌、权限、会话和审计按 `clientId` 隔离。
- 用户可以选择“仅允许一个写入客户端”或“允许多个可信写入客户端”。

### 4.4 协议策略

- 基线兼容 MCP `2025-11-25` 的稳定 tools/resources/prompts/lifecycle 能力，并在实现时列出经过测试的向后兼容协议版本。
- 对实验性的 MCP Tasks 只做能力协商后的增强映射。
- 内部长任务系统不能依赖 MCP Tasks，保证不支持 Tasks 的客户端仍可使用完整功能。
- 对外声明服务版本、协议版本、能力版本和数据 Schema 版本。
- 官方 TypeScript SDK 使用 lockfile 中的精确版本，不使用浮动或 caret 范围；升级 SDK 必须重新运行协议与真实客户端兼容套件。
- 明确定义 initialize/version negotiation、session header、session 过期、HTTP 404 重建会话、无 Streamable HTTP 客户端的 stdio 回退和版本不兼容错误。
- 内部 jobs 与 MCP Tasks 保持独立 ID 和状态机；仅在协商支持时建立映射：`queued/running → working`、`waiting_approval → input_required`、`completed/failed/cancelled` 对应同名终态，`interrupted` 映射为 failed 并携带可恢复信息。

参考：

- [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP Server Features](https://modelcontextprotocol.io/specification/2025-11-25/server/index)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

## 5. 对外能力模型

### 5.1 设计原则

1. 工具描述业务意图，不暴露任意 SQL、任意文件操作或原始 IPC 转发。
2. 查询默认分页，支持字段选择和摘要模式，避免一次返回全部数据库。
3. 单对象更新尽量使用 patch 和 `expectedRevision`，避免完整对象覆盖。
4. 批量修改通过变更集执行，先计算影响范围，再应用。
5. 每个写工具声明风险、幂等性、是否可撤销和是否产生外部副作用。
6. 工具结果优先返回结构化数据；大对象通过资源链接读取。
7. App 能力广泛开放，权限策略决定某个客户端能否调用，而不是为安全而永久删减能力。

所有外部操作必须登记在可执行的 operation catalog 中，catalog 是生成 MCP 工具、权限检查和文档的单一事实源：

```ts
interface OperationDescriptor {
  name: string;
  requiredScopes: string[];
  resolveRisk(input: unknown, state: ResolvedState): RiskLevel;
  sideEffects: Array<'database' | 'managed_files' | 'external_process' | 'network' | 'ui'>;
  idempotency: 'required' | 'supported' | 'none';
  recovery: 'inverse' | 'quarantine' | 'consistency_bundle' | 'none';
  maxAffectedEntities: number;
  approvalPolicy: string;
}
```

Catalog descriptors are code-defined, runtime-validated, and versioned with a canonical catalog hash. Persisted policy may select only behavior explicitly allowed by the descriptor (for example, a lower max page size or a confirmation requirement); it cannot add scopes, lower a resolved risk, remove required idempotency, remove a recovery requirement, or disable a safety invariant. Every R4 grant and approval records the catalog version/hash and is rejected when it no longer matches.

风险由校验后的参数和实际解析出的资源共同决定，不能只按工具名静态判断。例如“删除记录但保留图片”和“同时物理删除图片”必须得到不同风险；“设置数据根目录但不迁移”和“跨卷迁移全部数据”也必须不同。catalog 必须覆盖数据根目录、物理删除、备份删除、导入资产删除、外部进程/OCR、网络模型调用、AI 配置和内容导出等现有权限类别。

### 5.2 能力域

| 领域 | 查询与资源 | 命令与动作 |
| --- | --- | --- |
| 系统 | 健康、版本、能力、数据修订、客户端状态 | 聚焦窗口、打开 App、刷新状态 |
| 错题 | 搜索、详情、图片元数据、标签、历史 | 创建、更新、归档、标签、掌握度、笔记、批量整理 |
| 复习 | 今日队列、逾期、薄弱、历史、算法解释 | 提交、撤销、延后、创建复习计划 |
| 知识体系 | 知识树、详情、掌握趋势、关联错题 | 绑定、解绑、重匹配、更新学习状态 |
| 外部题库 | 搜索、题目、解析、作答历史 | 记录作答、加入错题本、组织练习集 |
| 学习监督 | 今日概览、资料、进度、会话、日复盘 | 创建任务、更新进度、记录会话、保存复盘 |
| 任务系统 | 清单、任务、日历、标签、关联 | 创建、更新、移动、拆分、完成、取消完成、延期 |
| 专注 | 当前状态、历史、统计 | 绑定任务、开始、暂停、恢复、结束、修改配置 |
| 习惯 | 列表、日志、连续记录 | 创建、更新、打卡、撤销、归档 |
| 分析 | 周报、薄弱项、复习负债、时间分配 | 保存建议、生成调整变更集 |
| 工作流 | 作业、变更集、审批、审计 | 预览、批准、应用、取消、回滚 |
| UI | 当前页面、选中对象、可导航目标 | 页面导航、打开对象、显示审批、展示结果 |
| 运维 | 备份列表、导入预览、导出状态 | 创建备份、导入、导出、恢复、迁移和清理 |

### 5.3 MCP Resources

建议提供资源模板而不是把每条数据都永久列在 `resources/list`：

```text
kaoyan://dashboard/today
kaoyan://dashboard/week/{date}
kaoyan://questions/{questionId}
kaoyan://questions/search{?query,subject,category,page}
kaoyan://reviews/due{?date,mode,page}
kaoyan://knowledge/{nodeId}
kaoyan://knowledge/{nodeId}/weakness
kaoyan://tasks/today
kaoyan://tasks/{taskId}
kaoyan://study/review/{date}
kaoyan://jobs/{jobId}
kaoyan://changesets/{changeSetId}
kaoyan://agent/capabilities
```

图片、教材页和大体积导出不默认内嵌，先返回元数据与受权限控制的资源链接。

### 5.4 MCP Prompts

Prompts 是用户主动选择的工作流入口，不把模型调用嵌入服务器：

- 制定今日学习计划。
- 进行周复盘并调整未来七天任务。
- 诊断当前错题并关联知识点。
- 清理逾期任务和复习积压。
- 根据考试日期评估计划可行性。
- 将一次对话中的学习决定落入 App。

## 6. 权限、信任和高自治模式

### 6.1 权限 Scope

权限按领域和动作拆分，而不是只有“只读/读写”两个开关：

```text
questions.read / questions.write / questions.archive
reviews.read / reviews.submit / reviews.reschedule
knowledge.read / knowledge.write
tasks.read / tasks.write / tasks.execute
focus.read / focus.control
study.read / study.write
files.images.read / files.textbooks.read / files.export
operations.batch / operations.backup / operations.restore
ui.read / ui.control
audit.read
```

### 6.2 风险级别

| 级别 | 含义 | 示例 |
| --- | --- | --- |
| R0 | 无学习数据或无副作用 | 健康检查、版本、能力 |
| R1 | 读取或可忽略副作用 | 查询错题、统计、打开页面 |
| R2 | 单对象、可恢复写入 | 创建任务、添加笔记、提交复习 |
| R3 | 批量或明显改变计划 | 批量延期、批量改掌握度、自动安排一周任务 |
| R4 | 破坏半径大或难恢复 | 删除数据、恢复数据库、迁移目录、清空数据 |

### 6.3 用户可选信任配置

#### 观察者

- 允许 R0-R1。
- 不允许写入。

#### 协作者

- 允许 R0-R1 自动执行。
- R2 每次确认或按领域长期授权。
- R3-R4 必须 App 内确认。

#### 高自治助手

- 允许 R0-R2 自动执行。
- R3 在有变更预览、可撤销或已创建恢复点时自动执行。
- R4 必须额外保护。
- 这是建议给可信 Codex 客户端的日常模式。

#### 完全控制

- 客户端获得所有业务 Scope。
- R0-R3 默认自动执行并完整审计。
- R4 可配置为自动准备，但执行前仍需满足安全不变量。
- 用户可以对特定 R4 操作开启限时授权窗口，例如未来 15 分钟内允许一次备份恢复。

R4 中的清空全部数据、恢复数据库和真实数据根目录迁移，默认要求 App 内用户可见确认。完全控制模式可以通过用户预先创建的限时授权窗口自动执行，但授权必须绑定具体操作、目标备份或目标目录、最大影响范围和有效次数；笼统的“允许所有 R4”不能永久绕过可见确认。删除单个备份、批次或物理文件可按 operation catalog、恢复资产和用户策略获得更细粒度的长期授权。

Trusted paired Codex defaults to 完全控制: R0-R3 auto-execute after catalog and policy admission, while R4 never receives blanket or permanent approval. An R4 execution requires an operation-bound, single-use or time-limited grant tied to the descriptor, canonical payload/target, catalog version, maximum impact, and recovery conditions. A policy may demand a visible confirmation more often, but may never turn that grant into an unrestricted R4 bypass.

An R4 grant is not consumed optimistically. During serialized control admission, Gateway's internal workflow implementation atomically changes an eligible grant from `active` to `reserved` and binds `clientId`, `requestId`, payload hash, affected-set hash, base epoch/revision, catalog hash, and reservation expiry. A unique active/reserved grant row and the single coordinator queue permit exactly one reservation. The receipt hook consumes that exact reservation only in the same business transaction that writes the terminal receipt and audit result. A definite pre-commit rollback finalizes a failed receipt/audit and releases the reservation in one later control write; an ambiguous publish never releases it and fences external writes. Restart reconciles only after candidate recovery: terminal receipt means consumed, admitted/reserved without a terminal receipt means interrupted-before-commit and can be released with an audit record. Concurrent callers receive `R4_GRANT_RESERVED` or `R4_GRANT_CONSUMED`, never a second execution.

### 6.4 安全不变量

即使完全控制模式也必须满足：

- 不返回 API Key、配对密钥和内部认证令牌。
- 不提供任意 SQL 或任意文件系统工具。
- 数据恢复、全量清空和数据根目录迁移前必须创建可验证恢复点。
- 不允许工具突破配置的数据根目录和明确授权的导入文件。
- 批量操作必须有有限影响范围和最大对象数。
- 客户端不能自行提高 Scope 或信任等级。
- 禁用外部控制或撤销客户端后，新请求立即失效。
- 审计和恢复点不能由执行同一高风险命令的客户端静默抹除。

### 6.5 审批绑定

审批不是一个可复用的布尔值或裸 token。每次审批形成持久、单次使用的 approval record，并绑定：

- `approvalId`、一次性 nonce 和过期时间。
- 已认证 `clientId`、客户端公钥指纹和会话主体。
- 工具/命令名称、canonical payload hash 和已解析的 affected-entity set hash。
- `dataEpoch`、`baseRevision`、风险等级、Scope 和恢复策略。
- 用户或策略引擎的决策来源及自动批准规则版本。

应用变更集前必须重新解析受影响对象、比较 epoch/revision、重新计算风险和策略，并以恒定时间比较 payload hash。审批使用成功、拒绝、撤销、客户端撤权、基础修订变化或过期后立即失效；同一审批不能用于重试一个已变化的计划。

## 7. 配对、认证与控制中心

设置页新增“外部智能体”控制中心：

- 总开关与服务状态。
- 配对新客户端。
- 已配对客户端、最后活动时间和当前会话。
- 权限 Scope 和信任模式。
- 临时授权窗口。
- 实时调用记录和待审批操作。
- 撤销客户端和立即终止全部写入。
- 审计检索、导出和保留策略。
- Codex、Claude 等客户端配置说明。
- 隐私提示：哪些数据可能因外部模型调用而离开本机。

Phase B treats this as a hard product gate, not a future settings placeholder: it must expose enable/status, clients and immediate revoke, scopes/trust, R4 grants, pending approvals/change sets, sessions and termination, audit search/export, active policy/catalog versions, and the external-data privacy disclosure. The Electron main process owns state mutation, preload exposes only typed control-center commands/queries, and the Renderer is a presentation Adapter over those Interfaces.

When external control is disabled, every external principal is denied before business admission. The local Renderer management principal remains usable only for a narrow code-catalog allowlist: status, enable/disable, client recovery/revoke, session termination, audit verification/search/export, and policy/catalog/privacy inspection. It does not receive any question, review, task, focus, file, backup, or generic business operation merely by being Renderer. Catalog mismatch fences external business writes while retaining this narrow local recovery allowlist so the user can inspect evidence, revoke clients, or disable control; local recovery actions remain audited by control writes.

配对由 App 内控制中心统一批准，但凭据协议按传输区分：stdio launcher 注册客户端签名公钥，直接 Streamable HTTP 客户端使用第 4.1 节的 OAuth 2.1 授权。一次性短码只能用于把待批准请求关联到当前 App UI，不能充当长期凭据或直接调用 MCP。

统一配对流程为：

1. stdio launcher 提交公钥和一次性关联码，或 HTTP 客户端发起带 PKCE/resource/state 的授权请求。
2. App 验证协议材料，并展示客户端名称、实现版本、redirect URI（如适用）和请求 Scope。
3. 用户选择信任配置并批准。
4. App 为 stdio 客户端保存绑定 `clientId` 的公钥；为 HTTP 客户端签发短期 access token，并仅在允许长期连接时签发可轮换 refresh token。
5. launcher 私钥、HTTP refresh token 和其他可续期材料仅存放在当前用户系统安全存储；受 ACL 保护的普通文件不能作为首选秘密存储。
6. 服务端保存公钥、token family 状态或凭据摘要，不在日志中记录私钥、授权码或原始令牌。

远程网络访问不在首个正式版本范围。若未来支持远程 MCP，应采用 MCP HTTP 授权规范要求的 OAuth 2.1、受保护资源元数据和 audience 校验，而不是复用本地令牌方案。

参考：

- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

## 8. 变更集、审批、撤销和回滚

### 8.1 变更集

批量或高风险操作先生成持久变更集：

```ts
interface ChangeSet {
  id: string;
  clientId: string;
  status: 'draft' | 'waiting_approval' | 'approved' | 'applied' | 'rejected' | 'expired' | 'rolled_back';
  dataEpoch: string;
  baseRevision: number;
  risk: 'R2' | 'R3' | 'R4';
  summary: string;
  operations: PlannedOperation[];
  affectedEntities: EntityRef[];
  backupId?: string;
  expiresAt: string;
}
```

典型流程：

```text
plan → preview → policy decision → approve if needed → apply transaction → emit events → audit
```

高自治或完全控制模式可以依据策略自动批准 R3，但仍保留预览和审计，避免“自动执行”变成“不可见执行”。

### 8.2 撤销与回滚

- 单对象命令记录反向操作或修改前快照。
- 批量操作记录受影响实体和旧值。
- 文件操作优先移动到受管理的 trash，而不是立即物理删除。
- R4 操作以第 3.2 节的一致性恢复包或可逆迁移计划为基础；数据库备份只是其中一个组成部分。
- 每个撤销能力明确有效期和可恢复范围。
- 不能可靠撤销的操作在执行前显著标记。

## 9. 持久作业系统

OCR、导入、导出、重匹配、批量计划和大范围分析使用内部持久作业：

```text
queued → running → waiting_approval → completed
   └──────────────→ failed / cancelled / interrupted
```

作业数据包含：

- 作业 ID、类型和客户端。
- 输入摘要和敏感字段过滤后的参数。
- 状态、进度、阶段和时间戳。
- 可取消性和恢复策略。
- 结果资源或错误码。
- 关联变更集、备份和审计记录。

标准工具：

- `jobs.list`
- `jobs.get`
- `jobs.cancel`
- `jobs.retry`
- `changesets.get`
- `changesets.approve`
- `changesets.reject`
- `changesets.apply`
- `changesets.rollback`

客户端断开不能导致作业状态丢失。App 重启后，未完成作业根据类型恢复、取消或标记为 `interrupted`，不能伪装成成功。

作业、变更集、审批、幂等记录和审计必须持久化，不能只存在于 MCP session 内。实现至少包含：

- `agent_clients`：客户端、公钥、Scope、信任模式、撤销时间。
- `agent_jobs`：所有者、类型、状态、进度、可重试性、结果资源、TTL。
- `agent_changesets` 与 `agent_changeset_operations`：基础 epoch/revision、影响对象、状态和恢复资产。
- `agent_approvals`：payload/affected-set hash、nonce、决策、过期和消费时间。
- `agent_idempotency`：`clientId + requestId` 唯一约束、参数哈希、结果引用和 TTL。
- `agent_audit_events`：append-only 审计序列和前后事件哈希。
- App `userData` 下的外部 operation manifests/recovery index，用于数据库替换期间的恢复。

所有 `list` 使用 cursor 分页并按调用客户端授权过滤。`get/cancel/retry/rollback` 只能由原客户端、获得管理 Scope 的客户端或 App UI 执行。仅声明为可安全重试且输入、epoch/revision 和幂等记录仍匹配的作业允许 `retry`；重试创建新的 attempt ID，但保留原逻辑 request/operation 关联。终态默认不可变，保留期限结束后按策略清理大结果，审计摘要继续保留。

## 10. 数据同步和 UI 控制

所有成功命令发布领域事件：

```text
question.created
question.updated
review.submitted
review.reverted
task.created
task.completed
knowledge.mastery_changed
focus.started
focus.ended
database.restored
```

Renderer 通过受控 IPC 订阅事件，并按领域刷新页面状态。MCP 对支持订阅或通知的客户端提供适当更新，但客户端不能依赖通知作为唯一一致性机制。

UI 控制使用结构化意图，而不是模拟点击：

```ts
interface NavigateIntent {
  target: 'dashboard' | 'question' | 'review' | 'knowledge' | 'task' | 'focus' | 'settings';
  entityId?: string;
  mode?: string;
  focusWindow?: boolean;
}
```

支持：

- 获取当前页面和选中对象。
- 聚焦主窗口。
- 打开指定错题、任务或知识点。
- 进入指定复习模式。
- 打开待审批变更集。
- 将作业结果呈现在对应页面。

只有没有业务接口且无法增加结构化控制的遗留交互，才使用桌面 UI 自动化。

## 11. 数据最小化与提示注入防护

高权限不等于不受控地把全部数据发送给模型：

- 查询默认分页并设置最大页大小。
- 支持 `summary | standard | full` 三种详细度。
- 图片和教材正文使用独立 Scope。
- 默认不返回真实绝对路径、API Key、令牌和内部配置。
- 审计记录参数摘要，不复制整份教材或所有图片内容。
- 错题、教材和导入文本视为不可信数据，不把其中的指令当作控制命令。
- 工具结果明确区分系统元数据和用户内容。
- 不允许用户内容改变权限、工具 Schema 或系统策略。
- 外部 URL、导入路径和资源链接必须经过 allowlist、路径规范化和边界校验。

## 12. API 契约与兼容性

### 12.1 版本

至少维护：

- App 版本。
- Agent API 版本，例如 `agentApiVersion: 1`。
- MCP 协议版本。
- 数据 Schema 版本。
- 工具目录版本及哈希。

### 12.2 Schema

- 在 `src/shared/agent/` 定义版本化 DTO、错误码、命令和查询契约。
- 运行时使用 JSON Schema 或等价校验器验证输入输出。
- MCP Schema 从同一契约生成，避免手写重复定义。
- IPC 契约也逐步复用这些类型和校验规则。
- 新字段优先向后兼容；破坏性修改通过新工具名或新 API 版本发布。

### 12.3 幂等

所有写请求包含 `requestId`：

- 同一客户端重复提交相同请求返回首次结果。
- 同一 `requestId` 携带不同参数时返回冲突。
- 幂等记录具有明确 TTL，但关键批量命令保留更长时间。
- 创建类命令可额外接受调用方稳定的 `externalRef`。

Every Gateway write is durable idempotency keyed by `{ clientId, requestId, canonicalPayloadHash }`. The unique admission key is `{ clientId, requestId }`: the same hash replays only a terminal receipt; a different hash returns a stable request conflict. Admission writes `admitted` under `controlRevision`; a successful business transaction atomically writes `completed`, its result, and required audit record. A known pre-commit failure is terminalized by one control transaction with its failure audit. A receipt left non-terminal after a selected-candidate restart is reconciled as `interrupted_precommit`, never re-executed automatically. A publication that remains ambiguous is recorded as `indeterminate` only after candidate recovery makes that control write safe, while external writes stay fenced. Ordinary terminal records retain 30 days. R4 records, jobs, and change sets follow their audit lifecycle rather than the ordinary TTL. Candidate ambiguity never invents a success state.

### 12.4 数据 epoch 与 revision

`dataRevision` 只在一个 `dataEpoch` 内单调递增，二者共同构成并发令牌：

```ts
interface DataVersion {
  dataEpoch: string;
  dataRevision: number;
}
```

- 普通数据库提交在同一事务内递增 `dataRevision`，成功持久化后才对外发布结果和事件。
- `dataEpoch` 与 revision 存放在业务数据库的控制元数据表中，使普通写入与 revision 原子提交。
- 恢复数据库、替换数据根或其他会替换数据库身份的操作，在新数据库接受请求前生成新的随机 epoch，并从 revision 0 开始；旧 epoch 的查询缓存、审批、变更集和写请求全部失效。
- create/patch/delete/batch 默认要求调用方提供最近读取到的 epoch/revision；对明确声明为 commutative 或 append-only 的命令，catalog 可以允许只校验 epoch。
- 比较失败返回当前版本、冲突对象引用和是否可安全重新规划，绝不静默覆盖。
- R4 切换期间 Gateway 进入 maintenance fence，拒绝新写入并等待已有写入结束；恢复完成、引用校验和 epoch 发布后再开放。

## 13. 审计与可观测性

审计记录至少包含：

- 时间、客户端、会话、工具和请求 ID。
- 风险级别、权限决策和审批来源。
- 输入摘要和受影响实体。
- 执行结果、耗时、错误码和数据修订变化。
- 关联作业、变更集、备份和撤销记录。

日志要求：

- 仅保存在本地。
- 不记录 API Key、令牌和完整敏感正文。
- 支持轮转、保留期限和用户导出。
- MCP stdio 的协议输出与日志严格分离。
- 可从控制中心查看“AI 刚刚做了什么”和“为什么需要批准”。

Audit is a local append-only, tamper-evident ledger. Each record commits its canonical record hash and the previous record hash within a numbered segment; verification detects deletion, reorder, or mutation. Clients have no delete Interface. Control-mode records cover authentication, admission, denial, query completion/failure, known business failure, grant reserve/release, client/policy/catalog changes, and restart reconciliation/indeterminate publication. Business-mode records cover a successful execution receipt and result in the same transaction. A business result is returned only after its terminal receipt/audit record and live database image verify; a query or denial is returned only after its control audit write verifies. If audit construction/storage fails before commit, the command rolls back; if durable publication is ambiguous, external writes fence and startup resolves the Phase A candidate before any replay or indeterminate control record. R0-R2 ordinary records retain at least 180 days; R3/R4, authentication, pairing, revocation, and policy/catalog events retain at least one year. App-controlled cleanup is itself R4, emits a final verifiable segment record, and begins a new segment with an explicit anchor to the prior segment. Search/export paginates by ledger sequence, applies principal-scoped redaction, and exports verification metadata rather than secrets.

## 14. 建议代码组织

```text
src/
  shared/
    agent/
      contracts/
      schemas/
      errors.ts
      capabilities.ts
  main/
    application/
      commandBus.ts
      queryBus.ts
      executionContext.ts
      domainEvents.ts
    persistence/
      databaseCoordinator.ts
      atomicPersist.ts
      revisionStore.ts
    agent/
      agentGateway.ts
      policyEngine.ts
      auditService.ts
      approvalService.ts
      changeSetService.ts
      jobService.ts
      clientRegistry.ts
      redaction.ts
    mcp/
      server.ts
      tools/
      resources/
      prompts/
      transport/
    ipc/
      adapters/
packages/
  kaoyan-mcp-stdio/
tests/
  agent/
  mcp/
  e2e/
```

不要求一次性搬迁所有旧文件。迁移应按领域逐步进行，但新 MCP 能力只能建立在新应用层之上。

### 14.1 迁移准入规则

渐进迁移不允许同一领域同时存在“受控 MCP 写入”和“绕过 Coordinator 的 Renderer/内部写入”。每个领域开放 MCP 写工具前必须完成：

1. 清点所有 Renderer、IPC、定时器、启动迁移、AI 服务和跨领域 bridge 写入口。
2. 标记直接 `getDatabase()`、`persistDatabase()`、本地 transaction 和文件副作用。
3. 将该领域全部写入口迁入同一 command executor；必要的只读数据库访问登记为显式例外。
4. 为命令补齐 operation catalog、Schema、epoch/revision、幂等、事件、审计和故障测试。
5. 静态检查阻止该领域新增绕过入口。
6. 通过 Renderer 与 Gateway 等价性测试后，才允许注册对应 MCP 写工具。

迁移台账按领域维护，至少覆盖现有 `registerIpc.ts` 的全部写通道。Phase A 的三个领域只是迁移模板，不代表其他未迁移领域可以提前暴露写工具。

### 14.2 Windows 打包与 launcher 分发

当前 electron-builder 仅生成 portable x64，且只打包 `dist`、`package.json`、`node_modules` 和既有 extra resources。正式方案明确增加：

- `packages/kaoyan-mcp-stdio` 编译为版本固定的 `dist/mcp-stdio/` 产物，构建失败时整体打包失败。
- 生成稳定的 `kaoyan-mcp` launcher，launcher 与 App 协议版本配套并进行签名/哈希校验。
- installed 模式把 launcher 放入稳定的用户级安装路径，并在用户确认后写入 MCP 客户端配置。
- 单文件 portable exe 不能假设解压目录稳定；首次启用外部控制时，由 App 经用户确认把 launcher 安装到 `%LOCALAPPDATA%/KaoyanMathMistakeBook/bin/<version>/`，并原子更新 current manifest。
- 稳定 launcher 根据受保护的 app-location registry 查找最近一次成功运行的 portable App；portable exe 移动后必须先运行一次 App 或由用户重新选择位置，不能搜索整盘或启动未知二进制。
- launcher 启动 App 时显式处理并隔离 `ELECTRON_RUN_AS_NODE`，避免污染 GUI 进程；stdio 自身不得继承会使 App 错误进入 Node 模式的环境。
- 升级先安装新 launcher/App 协议组合并完成自检，再切换 current manifest；失败可回退上一版本。

打包验收矩阵至少包括：开发模式、win-unpacked、单文件 portable、稳定安装路径、portable 移动、App 未运行、App 已运行、多 launcher 并发、升级、回滚、旧客户端连接新 App 和新客户端连接旧 App。

## 15. 实施路线

本路线是完整产品的分阶段建设，不把第一阶段定义为最终 MVP。

### Phase A：应用控制内核

- 建立版本化 agent contracts。
- 实现 Command Bus、Query Bus 和 ExecutionContext。
- 实现 Database Coordinator、事务、原子持久化和数据修订。
- 建立领域事件总线。
- 选择错题、复习和任务三个领域完成端到端迁移模板。
- 建立跨数据库/文件操作的 journal、staging、quarantine 和启动恢复框架。
- 保持现有 Renderer 行为不变。

验收：UI 与测试全部通过；并发写入可检测 epoch/revision 冲突；数据库失败完整回滚；跨资源失败按 journal 恢复为 completed、compensated 或明确的 needs_recovery，不出现未知成功状态。

### Phase B：Agent Gateway 与权限基础

- 实现客户端注册、Scope、风险策略和信任配置。
- 实现幂等、审计、字段过滤、分页和统一错误。
- Renderer IPC 逐步复用 Gateway。
- 建立控制中心的服务状态和客户端管理基础页面。
- 建立 operation catalog、审批绑定和领域迁移准入检查。

验收：同一业务操作从 Renderer 和 Gateway 产生一致结果和事件；重复请求不会重复写入。

### Phase C：完整 MCP 能力面

- 接入官方 TypeScript MCP SDK。
- 实现 tools、resources、resource templates 和 prompts。
- 覆盖错题、复习、知识、题库、监督、任务、专注、习惯、分析和 UI 控制。
- 实现 App 内 Streamable HTTP 服务。
- 实现 stdio launcher 和 App 自动发现/启动。
- 固定 SDK/协议版本并完成 Windows launcher 分发与升级路径。

验收：至少两个真实 MCP 客户端通过兼容矩阵；逐领域完成迁移准入后开放工具；App 关闭、重启、portable 移动和升级后的连接行为明确可靠。

### Phase D：高自治执行系统

- 实现变更集、审批、自动批准策略和限时授权。
- 实现持久作业、进度、取消、重试和中断恢复。
- 实现单对象撤销、批量回滚和高风险备份保护。
- 完成高自治助手及完全控制模式。

验收：可信 AI 可以在不频繁打断用户的情况下完成一整天或一整周的计划调整，并且所有修改可解释、可追踪、在设计承诺的范围内可恢复。

### Phase E：产品化与硬化

- 完成外部智能体控制中心。
- 增加 Renderer/Electron E2E。
- 覆盖多客户端并发、断线、过期凭据和撤权。
- 完成路径穿越、提示注入、DNS rebinding、令牌泄露和拒绝服务测试。
- 完成 portable Windows 包的安装、发现、配对和升级验收。
- 编写用户文档、隐私说明、客户端配置和故障排查。

验收：满足第 16 节完成标准，且禁用外部控制后 App 所有原有能力独立可用。

## 16. 完成标准

只有同时满足以下条件，Agent Control Plane 才算完成：

1. 外部智能体覆盖主要学习工作流，而非只调用少数演示工具。
2. MCP 与 Renderer 操作遵循相同业务规则、事务和副作用。
3. 外部进程永不直接写数据库。
4. UI 和多个客户端并发修改不会静默覆盖。
5. 所有写操作具有幂等、防重复和可检查的执行结果。
6. 所有智能体写操作可追踪到客户端、请求和受影响实体。
7. 用户可以为可信 AI 开启高自治或完全控制模式。
8. R4 操作始终满足恢复点、边界校验等安全不变量。
9. 批量失败不会留下未知的半完成状态。
10. 客户端断开或 App 重启不会让长任务伪装成功或永久失联。
11. Renderer 能响应外部数据变化并导航到智能体操作结果。
12. portable 打包版能够被真实 MCP 客户端安装、发现、配对和调用。
13. 禁用 MCP 后 App 仍然完整独立运行。
14. 自动化测试覆盖契约、权限、事务、作业、MCP 协议和关键 Electron 交互。
15. 文档清楚说明外部云端模型可能看到的数据范围和用户的撤权方式。

### 16.1 量化验收矩阵

| 类别 | 必须通过的可测场景 |
| --- | --- |
| 协议 | 支持版本逐一完成 initialize、tools/resources/prompts、session 创建/过期/重建；不支持版本返回稳定错误 |
| 配对 | 未配对和只读取 discovery 的进程 100% 被拒绝；撤权后下一请求即失败；旧 session 不跨 App 实例有效 |
| 权限 | operation catalog 每个变体均有 allow/deny 测试；风险随参数和解析状态变化；客户端不能自提权 |
| 审批 | payload、影响对象、epoch/revision、client 或 nonce 任一变化均使审批失效；审批不可重放 |
| 幂等 | 同请求重复至少 3 次只产生一次副作用；相同 requestId 不同参数稳定冲突 |
| 并发 | 两客户端对同一基础版本写入时仅一个成功，另一个收到可重规划冲突；无静默覆盖 |
| 持久化 | 在 export、temp write、flush、replace、reopen 各故障点注入失败，旧库或新库至少一个可验证可打开 |
| 跨资源操作 | 每个 journal phase 强制崩溃并重启，最终只允许 completed、compensated、needs_recovery 三类可解释结果 |
| R4 | 清空、恢复、目录迁移和物理删除均验证恢复资产、哈希、磁盘空间不足拒绝、回滚/人工恢复路径 |
| 作业 | 断开客户端和重启 App 后作业所有权、状态和结果一致；未授权客户端不能 list/get/cancel/retry |
| 数据隔离 | 图片、教材、路径和密钥 Scope 分别测试；分页和最大返回量不可绕过 |
| Electron | 使用隔离数据根的真实 Electron 进程完成配对、审批、外部写入、事件刷新、导航和撤权 E2E |
| 打包 | 第 14.2 节全部 Windows 形态完成 launcher 发现、认证、升级、回退和环境变量测试 |

每个高风险工具必须在 operation catalog 中关联至少一个自动化允许用例、拒绝用例、恢复用例和审计断言。不能用“主要工作流可用”替代这些验收证据。

## 17. 明确不采用的方案

### 独立 MCP 直接读写数据库文件

拒绝。它破坏 `sql.js` 内存数据库的单一所有权，可能覆盖 App 尚未持久化的数据。

### 把现有 IPC 一对一复制成 MCP 工具

拒绝。IPC 是 Renderer 适配层，不是稳定的外部产品契约；直接复制会继承粒度、校验、错误和副作用不一致问题。

### 只做桌面 UI 自动化

拒绝作为主方案。UI 自动化脆弱、难以事务化、难以审计，也无法可靠表达业务结果。仅作为遗留能力的最后补充。

### 在 MCP Server 内再调用固定 AI 模型

默认不采用。外部客户端已经承担推理，服务器应保持确定性和供应商中立。现有 DeepSeek/OCR 功能可以作为 App 自身可选能力继续存在。

### 永久只读或所有写入逐次确认

拒绝作为唯一模式。它无法实现用户期望的高自治智能。产品必须提供受控但真正可用的高权限模式。

## 18. 关键决策摘要

| 决策 | 选择 |
| --- | --- |
| AI 形态 | 外部智能体，不在 App 内复制聊天产品 |
| 控制边界 | Agent Gateway + Application Command/Query Bus |
| Gateway Interface | 仅 `execute(commandEnvelope, principal)` 与 `query(queryEnvelope, principal)` |
| 身份 Seam | ClientAuthenticator 签发不可伪造 AgentPrincipal；Gateway 不接收原始凭据 |
| 数据所有权 | Electron 主进程唯一持有和写入数据库 |
| 本地传输 | App 内 Streamable HTTP + stdio launcher |
| 权限方向 | 完整能力面 + 用户可选高自治/完全控制 |
| 可信 Codex 默认 | 完全控制；R0-R3 自动执行，R4 仅 operation-bound 一次性/限时授权 |
| Catalog 与 policy | code-defined/versioned catalog；policy 只能在 descriptor bounds 内变化 |
| Phase B 产品门槛 | 完整控制中心、耐久幂等、tamper-evident 审计及首两批领域 Gateway 迁移 |
| 批量写入 | 持久变更集、策略审批、事务执行、可恢复设计 |
| 长任务 | App 内持久作业，MCP Tasks 仅作可选映射 |
| UI 联动 | 领域事件 + 结构化导航，不依赖模拟点击 |
| 兼容策略 | 版本化契约、运行时 Schema、幂等和修订控制 |
| 模型依赖 | 供应商中立，现有 DeepSeek 能力保持可选 |
