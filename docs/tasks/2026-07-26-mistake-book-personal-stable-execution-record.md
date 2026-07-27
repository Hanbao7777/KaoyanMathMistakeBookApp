# 错题本个人日用稳定版执行记录

## 用途

本文件是
[`2026-07-26-mistake-book-next-phase-stabilization-plan.md`](./2026-07-26-mistake-book-next-phase-stabilization-plan.md)
的执行证据入口，集中保存：

- 本地基线检查结果
- 拟发布的 GitHub 总 Issue 草稿
- portable EXE 候选版本验收模板
- 阻断问题、非阻断问题和最终用户确认

本文件不得记录 API Key、数据库内容、错题内容、图片、真实备份内容或可识别的
私人数据路径。

## Batch 1 本地预检

### Git 状态

检查日期：2026-07-26

| 项目 | 结果 |
| --- | --- |
| 当前分支 | `main` |
| HEAD | `22f450c73974269e73551f4b25a883616ad2ef1f` |
| HEAD 摘要 | `22f450c feat: close Phase C packaging` |
| 相对 `origin/main` | ahead 69，behind 0 |
| 已跟踪文件改动 | 0 |
| 检查时未跟踪文件 | 32 |

未跟踪文件中包含多种 Agent、MCP 和编辑器本地配置。后续候选提交采用允许清单，
只纳入以下稳定化文档：

- `docs/tasks/2026-07-26-mistake-book-next-phase-stabilization-plan.md`
- `docs/tasks/2026-07-26-mistake-book-personal-stable-execution-record.md`

其余未跟踪文件不得因稳定化提交被顺带加入。

### 本地质量基线

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm test` | 通过 | 700 tests；699 pass；0 fail；1 skip；完整复跑约 200.3 秒 |
| `npm run typecheck` | 通过 | renderer 与 main TypeScript 检查均为 exit code 0 |
| `npm run build` | 通过 | Vite 处理 1797 modules，约 5.09 秒完成 |

补充说明：

- 第一次 `npm test` 受执行工具 60 秒窗口限制而被终止，未形成测试结论；随后使用
  可续接执行完整复跑并通过。
- 测试输出包含临时 Codex profile PATH alias 警告、Node `DEP0190` 警告以及预期的
  协议失败日志，但没有测试失败。
- build 报告主 renderer chunk 超过 500 kB。这是非阻断构建警告，本阶段不为此
  开展结构重构。

## Batch 2 首次 CI 诊断

### 远端对象

| 项目 | 记录 |
| --- | --- |
| GitHub 总 Issue | `#1 Personal stable closure: portable daily-use acceptance` |
| 草稿 PR | `#2 docs: define personal stable closure plan` |
| 首次 CI run | `30185609677` |
| 首次 run commit | `0e4b08cf21d8af3f99cf67796ed6b1d33e84fb74` |
| 首次 run 结果 | 用户授权取消；取消前长期停在 `npm test` |

### 根因

首次 workflow 使用 `ubuntu-latest`，但完整测试包含 Windows Electron、PowerShell、
portable EXE、Windows ACL、junction 和 `D:\` 路径语义。日志显示：

- Electron harness 的 3 项测试因 Linux SUID sandbox 配置失败；
- HTTPS metadata 测试因 `pwsh.exe` 不存在失败；
- Linux 逐文件复现进一步发现 diagnostic bundle、launcher 和 C0 spike 的
  Windows 路径或 EXE 假设失败；
- `loopbackHost.test.cjs` 的 Windows ACL 用例在 Linux 上断言失败，且失败路径没有
  执行 `host.stop()`，留下监听器，使 Node 测试进程不退出。

最小挂起复现：

```text
timeout 6s node --test --test-name-pattern="host closes and removes discovery" tests/mcp/loopbackHost.test.cjs
```

结果先产生 `Missing expected rejection`，随后由 `timeout` 以 exit 124 终止。

### 修复决策

1. CI runner 改为 `windows-latest`，与产品和测试的真实平台一致。
2. CI job 添加 30 分钟超时，避免活动句柄泄漏占用 runner 数小时。
3. 明确标记已识别的 Windows 专属测试，不再让 Ubuntu 误执行。
4. Windows ACL 测试使用 `try/finally`，断言失败时也保证关闭 host。

## Batch 2 第二次 CI 诊断

| 项目 | 记录 |
| --- | --- |
| CI run | `30187226175` |
| run commit | `f9c021e63c50abf47fee8a2ef517b23b92a581a2` |
| runner | `windows-latest` |
| 结果 | `npm test` 在约 77.7 秒后明确失败；309 pass，383 fail，8 skip |

这次失败不是业务逻辑回归，而是两个干净环境问题：

1. GitHub Windows runner 的默认临时目录使用 `RUNNER~1` 形式的 8.3 短路径。
   测试从 `os.tmpdir()` 创建受控临时根，而安全边界会用 `realpath` 展开成长路径并
   拒绝非规范路径。日志中有 324 个 `RECOVERY_FENCE`，其余大量失败为
   `Launcher root`、`LocalAppData`、`Discovery root` 等路径
   `is not canonical`，属于同一根因的级联结果。
2. `npm test` 原先只构建 main 和 launcher，不构建 renderer。开发机已有
   `dist/renderer` 时测试通过，但全新 CI checkout 的 Electron smoke fixture
   报 `Built Electron outputs are required`。

秒级路径复现使用 Windows 现有短路径别名验证：短路径经 `realpath` 展开后与输入
不相等，普通长路径相等。修复不放宽任何路径安全检查，而是：

- CI job 将 `TEMP` 和 `TMP` 指向 `${{ runner.temp }}`；
- `npm test` 改为先执行完整 `npm run build`，确保 renderer 产物来自当前 commit。

### 第二次修复后的本地验证

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm test` | 通过 | 先完成 Vite renderer build；700 tests；699 pass；0 fail；1 skip；约 188.4 秒 |
| `npm run typecheck` | 通过 | exit code 0 |
| `npm run build` | 通过 | Vite 处理 1797 modules；exit code 0 |

独立 Windows CI 结果在下一次 branch push 后补录。

### Workflow 表达式修正

提交 `bf3d7c5` 触发的 run `30187544438` 没有创建 job。GitHub 将其判定为
workflow file issue：`runner` 上下文不能用于 job 顶层 `env`。因此把
`TEMP`、`TMP` 的覆盖移动到 `Run tests` step；测试执行期间仍使用同一个
`${{ runner.temp }}`，但表达式位于 GitHub 支持的上下文。

### Windows CI 最终结果

| 项目 | 记录 |
| --- | --- |
| 首个全绿 Windows run | `30187574402` |
| 首个全绿 commit | `e5aa2ace2dce5b895aa888d918aa36f4b58cca0a` |
| 最终候选 run | `30188516301` |
| 最终候选 commit | `3f66aa4e790c3957aa369069cd44962f298a6160` |
| 最终候选结果 | 通过；Windows `verify` job 约 4 分 40 秒 |
| 最终候选门禁 | `npm test`、`npm run typecheck`、`npm run build` 均通过 |

## Batch 3 复习撤销与备份恢复收口

### 复习撤销根因与修复

复习页原来的“撤销（5 秒内）”只把掌握程度改回去，没有删除刚写入的复习日志，
也没有还原 `review_count`、`correct_count`、`wrong_count` 和
`next_review_at`。这会让界面看似撤销成功，但数据库统计仍然多记一次复习。

修复后，renderer 通过新增的 `reviews:undoResult` IPC 调用已有
`questions.undo_review` Gateway 命令，使用本次提交返回的真实
`reviewLogId` 做持久化撤销。该操作只加入 renderer 内部业务白名单，外部 MCP
操作清单没有扩大。

| 验证 | 结果 |
| --- | --- |
| 首轮聚焦测试（修复前） | 22 tests；15 pass；7 fail，确认缺少撤销通道和契约 |
| 安全与契约聚焦测试 | 38 tests；38 pass；0 fail |
| 最终 `npm test` | 705 tests；704 pass；0 fail；1 skip；约 187.6 秒 |
| 最终 `npm run typecheck` | 通过 |
| 变更文件 ESLint | 0 error；保留 ReviewPage 原有 2 个 hook dependency warning |
| `git diff --check` | 通过 |

### 两个一次性根目录的备份恢复

新增回归测试在同一个系统临时父目录下创建两个互不重叠的一次性数据根：

1. 在源根初始化数据库、写入合成 TickTick 任务并创建维护型数据库备份；
2. 重置数据库连接，在目标根初始化全新数据库；
3. 把备份复制到目标根的 App 管理备份目录并执行正式恢复服务；
4. 验证只恢复出源根中的合成任务，并验证恢复前保护备份存在；
5. 测试结束后删除整个测试临时根。

`tests/main/backupService.test.cjs` 最终结果为 4 tests、4 pass、0 fail。全过程没有
打开或修改 `D:\KaoyanMathMistakeBook`。

## Batch 4 真实日用验收与阻断修复

### 人工验收结论

2026-07-27，用户在已有真实备份保护下完成最终人工确认，并明确反馈：
“人工确认完成，没有问题”。本次确认覆盖此前要求补测的错题修改、提交复习、
撤销复习和 TickTick 页面非崩溃冒烟；此前还已实际完成 MCP 测试错题导入、
错题库查找和查看、删除测试错题、应用重启以及备份恢复确认。

真实备份的私人路径和内容未写入本记录。只记录已确认存在一份 2026-07-26
创建的升级前手动备份，且上一版和人工验收版 portable EXE 均已保留。

### 人工验收期间发现并修复的问题

| 现象 | 根因 | 修复与回归证据 | 状态 |
| --- | --- | --- | --- |
| 配对客户端启动、修复或轮换后 MCP 发现不稳定 | 配对与 MCP Host 使用了不同发现目录，发现记录也没有续期 | 统一运行目录和实例 UUID；健康配对刷新已启用 Host；新增发现续期、目录一致性和实例绑定测试 | 已解决 |
| MCP 握手成功后第一条业务查询返回 `CLIENT_REVOKED` | stdio 签发的 principal 未登记到 Gateway 当前活动绑定 | stdio 认证成功后登记活动绑定；新增真实 principal Gateway 查询回归 | 已解决 |
| 从首页进入错题库显示 `The request is invalid.` | Library 页面把空字符串筛选值传给严格 schema | 空字符串按“未设置筛选”处理；新增 Library 完整空筛选模型回归 | 已解决 |
| 首页卡片进入错题库偶发 `Writes are temporarily fenced for maintenance.` | 两条并发只读查询的持久审计写入互相触发写入栅栏 | Gateway 将“查询与该查询审计”顺序执行；新增并发 Gateway 与首页筛选/总数回归 | 已解决 |
| 已撤销客户端仍显示在授权客户端操作列表 | 页面把历史撤销记录和活动客户端混合显示 | 操作列表只显示未撤销客户端；历史记录仍保留在审计数据中 | 已解决 |

### 最终本地门禁

| 命令或检查 | 结果 |
| --- | --- |
| `npm test` | 通过；714 tests，713 pass，0 fail，1 skip |
| `npm run typecheck` | 通过 |
| `npm run test:main` | 通过；541 tests，541 pass，0 fail |
| `npm run pack:win` | 通过；Phase C 包结构校验返回 `ok: true` |
| 提交版启动冒烟 | 通过；主窗口可见且进程响应正常 |
| `git diff --check` | 通过 |

## GitHub 总 Issue 草稿

> 状态：已按本草稿创建 GitHub Issue #1。下文保留创建时的正文快照，后续远端
> 编辑仍需保持在已授权的稳定化范围内。

建议标题：

```text
Personal stable closure: portable daily-use acceptance
```

建议标签：

```text
ready-for-agent
```

建议正文：

```markdown
## Goal

Close a personal daily-use stable version of the mistake-book app. This is not
a public release gate.

## Core flow

- Import one disposable test question through Codex/MCP.
- Find, view, and edit it in the packaged app.
- Submit one review and undo it.
- Restart the app and verify the final state persists.
- Create and restore a backup in a separate disposable data root.
- Smoke-switch the existing TickTick mode/page without a crash.

## Safety

- Automated and technical acceptance must not access or modify
  `D:\KaoyanMathMistakeBook`.
- Keep the previous known-good portable EXE and a recoverable pre-upgrade backup.
- Do not record private study data, credentials, or private artifact contents.

## Blocking failures

- Data loss, corruption, or unreadable data
- App crash or failure to launch
- Any failed core-flow step
- Incorrect state after restart
- Backup restore failure or incorrect restored state

Cosmetic and explicitly deferred low-frequency issues are recorded but do not
block personal daily use.

## Acceptance

- [ ] Stabilization branch passes test, typecheck, and build in CI.
- [ ] Portable EXE identity and SHA-256 are recorded.
- [ ] Core flow passes against a disposable data root.
- [ ] Backup restore passes against a second disposable root.
- [ ] `reviewSession` focused correctness evidence passes.
- [ ] TickTick mode/page switch does not crash the app.
- [ ] No blocking issue remains open.
- [ ] Previous EXE and pre-upgrade backup are retained.
- [ ] The user completes a five-minute normal-use confirmation.

## Deferred

Claude Code token exchange, DeepTutor, built-in AI/OCR Beta, `masteryDisplay`,
deep TickTick work, repository-wide lint cleanup, structural refactoring, code
signing, installer, auto-update, and public release work.

## Evidence

- Stabilization plan:
  `docs/tasks/2026-07-26-mistake-book-next-phase-stabilization-plan.md`
- Execution record:
  `docs/tasks/2026-07-26-mistake-book-personal-stable-execution-record.md`
```

## portable 候选版本验收模板

### 候选版本身份

| 字段 | 记录 |
| --- | --- |
| 验收日期 | `2026-07-27` |
| commit | `bf18993f276a52f111a9961f47eafc78d3718f0b` |
| CI run | `待推送后运行；上一候选 30188516301 已通过` |
| portable 文件名 | `考研高数错题本 0.1.0.exe` |
| portable 大小 | `112,685,733 bytes` |
| SHA-256 | `501e5507743f0abca0581ab12c2c2f09075f391dde9a335db43ec23991f4dd9a` |
| Windows 版本 | `10.0.19045` |
| 测试数据根标识 | `kaoyan-portable-e2e-nlmKuG`（执行后已删除） |

### 前置条件

- [x] 当前候选 commit 的 `npm test` 通过。
- [x] 当前候选 commit 的 `npm run typecheck` 通过。
- [x] 当前候选 commit 的 `npm run build` 通过。
- [ ] 当前候选 commit 的 CI 通过（等待推送授权）。
- [x] `ELECTRON_RUN_AS_NODE` 未影响候选 EXE 启动。
- [x] 验收使用新建的一次性测试数据根。
- [x] 验收过程没有打开或修改 `D:\KaoyanMathMistakeBook`。

### portable 核心链路

- [x] 干净临时数据根首次启动和初始化成功。
- [x] Codex/MCP 成功导入一条测试错题。
- [x] 应用内可以找到并打开该错题。
- [x] 修改错题后内容正确保存。
- [x] 提交一次复习后状态正确。
- [x] 撤销复习后状态正确。
- [x] 退出并重新启动 portable EXE 后 harness 持久状态仍然正确。
- [x] TickTick 相关模式或页面可以进入、切换，应用不崩溃。

portable harness 首次启动完成 28 条断言，重启完成 10 条断言；两次进程均
exit 0、stderr 0 bytes。重启后隔离数据库为 1,249,280 bytes。该 harness
证明实际 portable 包的 main、preload、renderer、typed IPC 和持久化重启链路，
但不冒充上面尚未勾选的人工错题页面操作。

### 备份恢复

- [x] 从第一临时数据根创建备份。
- [x] 在第二临时数据根执行恢复。
- [x] 恢复后的合成数据与预期一致。
- [x] 恢复流程产生预期的保护备份。
- [x] 整个过程未接触真实数据目录。

### 问题记录

#### 阻断问题

| 编号或本地草稿 | 现象 | 最小复现 | 状态 |
| --- | --- | --- | --- |
| 无 | 人工验收和自动化范围内没有遗留阻断问题 | — | — |

#### 非阻断已知问题

| 编号或本地草稿 | 现象 | 影响 | 后续决定 |
| --- | --- | --- | --- |
| local-warning-1 | renderer 主 chunk 大于 500 kB | 启动体积与加载性能警告，不影响正确性 | 个人稳定版后再做结构优化 |
| local-warning-2 | 当前包使用 Electron 默认图标 | 外观问题 | 不阻断个人日用 |

### 回滚保障

- [x] 上一版已知可用 portable EXE 已保留。
- [x] 用户真实数据的升级前备份已存在且可识别。
- [x] 新版异常时停止使用候选 EXE，改用归档的上一版 EXE。

真实备份的具体私人路径和内容不写入仓库，只记录“已确认”。

上一版归档文件：
`release/archive/考研高数错题本 0.1.0.previous-20260722-4f38deae2f11.exe`；
大小 112,673,146 bytes；SHA-256
`4f38deae2f117bb9433ffb3b5fce6fe958c2bbda6eb84fd39432e45a6aff6528`。

### 最终结论

| 项目 | 记录 |
| --- | --- |
| 技术验收 | `本地通过：完整测试、类型检查、打包校验、隔离启动/重启、复习撤销、跨根备份恢复和人工页面链路均已通过；等待最终提交 CI` |
| 阻断问题数量 | `0` |
| 非阻断问题数量 | `2` |
| 用户 5 分钟确认日期 | `2026-07-27` |
| 用户结论 | `人工确认完成，没有问题；可以日用` |
| 是否标记为个人稳定版 | `本地候选通过；等待 bf18993 对应远端 CI 后正式标记` |

## 远端状态与后续授权点

当前已完成：

1. 创建 GitHub 总 Issue #1。
2. 创建并推送 `stabilization/personal-stable-2026-07-26`。
3. 创建面向 `main` 的草稿 PR #2。
4. 首次 Ubuntu CI 异常 run 已经用户授权取消。
5. 第二次 Windows CI 已明确暴露临时目录短路径和缺失 renderer 构建问题；
   修复后的 Windows CI 已连续在 `30187574402` 和 `30188516301` 通过。
6. 原候选 commit `3f66aa4` 已推送，portable 包已完成本地构建与隔离
   首启/重启验证。
7. 人工验收期间发现的 MCP 配对、Gateway principal、Library 筛选和并发查询问题
   已在本地 commit `bf18993` 修复；完整测试、提交版打包和启动冒烟已通过。
8. `bf18993` 尚未推送，最终 CI run 待用户另行授权。

草稿 PR 的创建和分支推送不授权合并。同步 `main`、把 PR 转为 ready 或合并 PR
必须在个人稳定版完成后另行确认。
