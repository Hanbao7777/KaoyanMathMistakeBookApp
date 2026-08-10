# 错题本主线 P0 稳定化任务

## Background

当前仓库最近几轮主要在收口 TickTick 和补最小测试体系，但接下来主线需要切回错题本本体。

经本地核对，错题本主线当前最优先的问题不是新增功能，而是交付稳定性与文档/验收口径：

- `typecheck` / `build` / GitHub Actions 已稳定通过
- `pack:win` 与打包版人工验收尚未形成稳定闭环
- `.gitattributes` 已存在，CRLF/LF 治理不再是“从零新增策略”，而是需要确认现状并清理过时文档表述
- 现有测试仍集中在 main/service 层，renderer 与 Electron 端到端主链路几乎空白

## Goal

完成错题本主线的 P0 稳定化盘点与收口顺序定义，明确哪些事项立刻执行，哪些事项降级到 P1。

## Non-Goals

- 不处理 TickTick 新问题
- 不新增错题本功能
- 不推进 PDF 教材联动能力
- 不在本轮直接做大规模架构重构

## Scope

- 打包与交付验收链路
- CRLF/LF 治理现状与旧文档纠偏
- 错题本主线最小回归缺口（renderer / Electron 侧）
- 错题本主线后续 P1 候选项的重新分层

## Constraints

- 优先做“真实阻塞交付”的事项，而不是优化型工作
- 所有结论都要以当前仓库现状为准，不沿用旧文档假设
- 文档要区分“已完成但未更新口径”和“尚未完成”
- 新文档放在分类目录，过时文档要标记为待归档或已过时

## Proposed Approach

1. 重新盘点 P0 事项是否仍成立。
2. 把已过时的 P0 项降级或删除，例如“CRLF/LF 治理未开始”这类与当前仓库不一致的表述。
3. 保留真正阻塞主线交付的事项：
   - `pack:win` + 打包版人工验收闭环
   - 错题本主线最小 renderer / Electron 回归方案
   - 主线文档口径同步
4. 将“考点汇总相关打磨”“数据库拆分”“批量操作”等移入 P1。

## Risks

- 旧文档如果不清理，会持续误导后续排期
- 若只看 main/service 测试通过，可能高估错题本页面主链路稳定性
- 打包版若没有固定验收流程，交付风险会在最后阶段集中暴露

## Acceptance Criteria

- 给出当前错题本主线真实 P0 清单
- 明确哪些旧问题已不再属于 P0
- 明确下一步执行顺序
- 输出结果可直接作为后续子任务派发依据

## Task Breakdown

1. 盘点现有 P0 候选项是否仍成立
2. 更新主线优先级分层
3. 输出可执行顺序
4. 标记需要同步的文档

## Verification

- 核对 `.gitattributes`、CI、`pack:win` 脚本、测试目录现状
- 对照 `README.md`、`ROADMAP.md`、`KNOWN_ISSUES.md` 判断是否存在过时表述

---

## 盘点结果（2026-07-04，基于当前仓库真实状态）

### 现状核对证据

| 事项 | 现状 | 证据 |
| --- | --- | --- |
| `typecheck` / `build` | 稳定通过 | ROADMAP“当前阶段重点”1；本地已多轮验证 |
| GitHub Actions CI | 已接入并运行 test/typecheck/build | `.github/workflows/ci.yml` 存在 |
| `.gitattributes` / 行尾符治理 | 已存在，工作区无未提交 diff | `git status --porcelain .gitattributes` 为空 |
| `pack:win` | 脚本存在，但无固定人工验收流程 | `package.json` 有 `pack:win`；无验收清单文档 |
| 测试覆盖 | 13 个用例文件，全部 main/service 层，renderer/Electron 端到端为 0 | `tests/main/*`、`tests/ipc/*`；无任何测试引用 renderer |
| PDF 教材联动 | 用户已明确降级为非主线 | 本任务 Key facts |

### A. P0 继续保留（真实阻塞主线交付）

1. **打包版验收闭环（`pack:win` + 人工验收流程）** — P0
   - 理由：能 `build` 不等于打包 exe 可启动可用；`ELECTRON_RUN_AS_NODE` 启动坑（KNOWN_ISSUES）已证明打包版与本地行为存在差异。当前没有固定的“打哪些包、验哪些主链路页面、记录结果”的清单，交付风险会在最后集中暴露。
   - 收口标准：一份可复现的打包验收清单（错题本主链路页面 + 启动环境清理步骤 + 通过/失败记录位置），跑通一次并留痕。

2. **错题本主链路最小 renderer/Electron 回归缺口** — P0（方案先行，非全量补测）
   - 理由：测试全在 main/service，错题本核心页面（错题库列表/详情、复习 Session、导入、Dashboard）无任何自动回归；main 层绿不代表页面主链路稳定。
   - 收口标准：本轮只需产出“最小回归方案 + 首批落地点”，不要求补齐全量。优先把可纯函数化的 renderer 逻辑下沉到 `src/shared` 做 node:test（沿用本仓已验证的 `src/shared/loadState.ts` + `tests/main/loadState.test.cjs` 模式），避免为此引入 jsdom/RTL 这类新框架（属超范围）。

3. **主线文档口径同步（纠偏过时 P0 表述）** — P0（轻量、可即时做）
   - 具体过时项：
     - `ROADMAP.md:15` “工作区改动收敛 — 分离真实逻辑改动与行尾符噪声，完成未提交 diff 的提交”——`.gitattributes` 已就位且工作区干净，此 P0 项已不成立，应移除或标记完成。
     - `ROADMAP.md:9-16` “当前阶段重点”仍以 TickTick 为主线语气，未反映“切回错题本主线、PDF 降级 P1”的最新决策，需补一条错题本主线重点。
   - 收口标准：ROADMAP 顶部“当前阶段重点”与错题本主线现状一致；不散落新文档到根目录。

### B. 从 P0 移出 → 降级 P1 / 已完成

1. **CRLF/LF 行尾符治理** — 移出 P0（已完成）
   - `.gitattributes` 已存在且无 diff；旧“从零新增策略/收敛行尾噪声”表述过时。降级为文档纠偏（并入 A-3），不再单列 P0。
2. **PDF 教材联动 / 内置 PDF.js 阅读器** — 移出 P0 → P1
   - 用户已明确非主线；ROADMAP 本就置于 V1.4/V2.0，保持 P1，不在本轮推进。
3. **考点汇总替换知识地图** — 保持 P1/Backlog（不升级）
   - 中高风险数据迁移，ROADMAP 已注明“需测试体系建立后推进”，依赖 A-2，不作为当前 P0。
4. **databaseService.ts / registerIpc.ts 拆分** — 保持 P1（V1.4 代码健康）
   - 优化型、非交付阻塞；Non-Goals 已排除大规模重构。
5. **批量操作、复习算法可配置化、交互增强** — 保持 P1（V1.4）
   - 均为功能增强，非稳定化。

### C. 下一步执行顺序（可直接派发子任务）

1. **A-3 文档口径纠偏**（最小、无依赖，先做）：修 `ROADMAP.md` 当前阶段重点 + 删除已完成的行尾符收敛 P0 项。
2. **A-1 打包验收闭环**：先产出打包验收清单文档（放 `docs/tasks/` 或 `docs/superpowers/`），再跑通一次留痕。
3. **A-2 renderer 最小回归方案**：先出方案 + 首批 shared 化落地点，再按点补 node:test；此项解锁后才具备推进 B-3 考点迁移的前置条件。

> 顺序理由：A-3 零风险即时收益；A-1 直接压交付风险；A-2 是后续所有主线改动的安全网与 B-3 的前置。B 类不在本轮动手。
