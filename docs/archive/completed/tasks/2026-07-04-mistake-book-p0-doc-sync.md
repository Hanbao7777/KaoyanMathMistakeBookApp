# 错题本主线 P0 文档纠偏任务

## Background

错题本主线 P0 盘点已完成，当前确认存在文档口径滞后：

- `ROADMAP.md` 仍把行尾符收敛列为当前阶段事项，但 `.gitattributes` 已存在且该项不再是活跃 P0
- `ROADMAP.md` 的“当前阶段重点”仍偏向 TickTick，未反映“切回错题本主线”的最新决策
- `KNOWN_ISSUES.md` 仍把 CRLF/LF 作为“待执行”问题描述，和仓库现状不一致

## Goal

把错题本主线相关文档口径同步到当前真实状态，移除过时的 P0 表述，并把主线重点切回错题本。

## Non-Goals

- 不修改任何业务代码
- 不展开 TickTick 新问题梳理
- 不新增功能路线图
- 不推进 PDF 教材联动，只允许在文档中把它保持为 P1/非当前重点

## Scope

- `ROADMAP.md`
- `KNOWN_ISSUES.md`
- 如确有必要，`README.md` 中仅修改与“当前主线重点”直接冲突的少量措辞

## Constraints

- 只修正文档和仓库现状不一致的地方
- 不夸大“已完成”；只写已验证的事实
- 不把 P1 项重新抬升到 P0
- 保持文档分类，不新增根目录临时说明

## Proposed Approach

1. 更新 `ROADMAP.md` 顶部“当前阶段重点”，把错题本主线放回第一优先级。
2. 删除或改写“行尾符收敛”这类已完成但仍写成当前事项的内容。
3. 更新 `KNOWN_ISSUES.md` 中 CRLF/LF 的状态，避免继续写成活跃待执行问题。
4. 保持 PDF 教材联动在 P1，不作为当前阶段重点。

## Risks

- 如果只改一处文档，其他文档仍保留旧口径，会继续误导排期
- 如果措辞过猛，把“文档同步”写成“问题完全消失”，会制造新的不一致

## Acceptance Criteria

- `ROADMAP.md` 当前阶段重点反映“错题本主线优先”
- 行尾符治理不再被写成当前 P0 事项
- `KNOWN_ISSUES.md` 中 CRLF/LF 状态与仓库现状一致
- 不修改代码，不新增无关文档

## Task Breakdown

1. 对照主线 P0 盘点结果逐条修正文档
2. 人工复核文档之间是否互相矛盾
3. 输出剩余仍属 P0 的事项，避免文档改完后又失焦

## Verification

- `git diff -- ROADMAP.md KNOWN_ISSUES.md README.md`
- 人工比对 `docs/archive/superseded/tasks/2026-07-04-mistake-book-mainline-p0-stabilization.md` 的已确认结论
