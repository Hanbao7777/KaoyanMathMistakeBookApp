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
| 验收日期 | `_待填_` |
| commit | `_待填_` |
| CI run | `_待填_` |
| portable 文件名 | `_待填_` |
| portable 大小 | `_待填_` |
| SHA-256 | `_待填_` |
| Windows 版本 | `_待填_` |
| 测试数据根标识 | `_待填，仅记录临时目录 basename，不记录用户名_` |

### 前置条件

- [ ] 当前候选 commit 的 `npm test` 通过。
- [ ] 当前候选 commit 的 `npm run typecheck` 通过。
- [ ] 当前候选 commit 的 `npm run build` 通过。
- [ ] 当前候选 commit 的 CI 通过。
- [ ] `ELECTRON_RUN_AS_NODE` 未影响候选 EXE 启动。
- [ ] 验收使用新建的一次性测试数据根。
- [ ] 验收过程没有打开或修改 `D:\KaoyanMathMistakeBook`。

### portable 核心链路

- [ ] 干净临时数据根首次启动和初始化成功。
- [ ] Codex/MCP 成功导入一条测试错题。
- [ ] 应用内可以找到并打开该错题。
- [ ] 修改错题后内容正确保存。
- [ ] 提交一次复习后状态正确。
- [ ] 撤销复习后状态正确。
- [ ] 退出并重新启动 portable EXE 后最终状态仍然正确。
- [ ] TickTick 相关模式或页面可以进入、切换，应用不崩溃。

### 备份恢复

- [ ] 从第一临时数据根创建备份。
- [ ] 在第二临时数据根执行恢复。
- [ ] 恢复后的错题和状态与预期一致。
- [ ] 恢复流程产生预期的保护备份。
- [ ] 整个过程未接触真实数据目录。

### 问题记录

#### 阻断问题

| 编号或本地草稿 | 现象 | 最小复现 | 状态 |
| --- | --- | --- | --- |
| `_待填_` | | | |

#### 非阻断已知问题

| 编号或本地草稿 | 现象 | 影响 | 后续决定 |
| --- | --- | --- | --- |
| `_待填_` | | | |

### 回滚保障

- [ ] 上一版已知可用 portable EXE 已保留。
- [ ] 用户真实数据的升级前备份已存在且可识别。
- [ ] 新版异常时的停止使用和退回方式已明确。

真实备份的具体私人路径和内容不写入仓库，只记录“已确认”。

### 最终结论

| 项目 | 记录 |
| --- | --- |
| 技术验收 | `_待填：通过 / 部分 / 失败_` |
| 阻断问题数量 | `_待填_` |
| 非阻断问题数量 | `_待填_` |
| 用户 5 分钟确认日期 | `_待填_` |
| 用户结论 | `_待填：可以日用 / 暂不使用_` |
| 是否标记为个人稳定版 | `_待填_` |

## 远端状态与后续授权点

当前已完成：

1. 创建 GitHub 总 Issue #1。
2. 创建并推送 `stabilization/personal-stable-2026-07-26`。
3. 创建面向 `main` 的草稿 PR #2。
4. 首次 CI 异常 run 已经用户授权取消，修复后的 CI 待重新验证。

草稿 PR 的创建和分支推送不授权合并。同步 `main`、把 PR 转为 ready 或合并 PR
必须在个人稳定版完成后另行确认。
