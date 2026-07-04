# GitHub Actions Node24 Runtime Upgrade Task

## Background

- 当前 CI workflow 仍使用：
- `actions/checkout@v4`
- `actions/setup-node@v4`
- GitHub Actions 当前运行时已对这些旧 major 给出 Node 20 deprecated 注记。
- 官方上游现状已核对：
- `actions/checkout` README 当前示例为 `@v7`
- `actions/setup-node` README 当前示例为 `@v6`

## Goal

- 用最小改动消除 CI 中的 Node 20 deprecated 注记，同时保持现有 `test / typecheck / build` 门槛不变。

## Non-Goals

- 不重写 CI 结构。
- 不新增 matrix、artifact、release、cache 策略重构。
- 不顺手改项目源码。

## Scope

- 更新 `.github/workflows/ci.yml`
- 如有必要，补最小文档说明

## Constraints

- 改动必须尽量小，只处理 Actions runtime 升级。
- 保持现有 Node 版本配置和执行步骤语义不变，除非升级 action 本身要求最小兼容调整。
- 需要独立验证 workflow 文件变更后本地工作区无额外副作用。

## Proposed Approach

- 将 `actions/checkout@v4` 升级到当前官方示例 major。
- 将 `actions/setup-node@v4` 升级到当前官方示例 major。
- 保留：
- `node-version: 22`
- `cache: npm`
- `npm ci`
- `npm test`
- `npm run typecheck`
- `npm run build`

## Risks

- Action major 升级可能引入默认行为细微变化，但当前 workflow 很简单，风险较低。
- `setup-node` 的自动缓存语义在新 major 有变化；当前已显式写 `cache: npm`，应保持行为稳定。

## Acceptance Criteria

- `.github/workflows/ci.yml` 仅做最小 action 版本升级和必要兼容调整。
- 本地无源码改动。
- 推送后 GitHub Actions 通过。
- 之后的 CI 不再出现本轮的 Node 20 deprecated 注记。

## Task Breakdown

1. 升级 workflow 里的 action major 版本。
2. 自审 diff，确认没有顺手改 CI 结构。
3. 提供变更说明与风险说明。
4. 推送后观察 CI 注记是否消失。

## Verification

- 文件检查：
- `.github/workflows/ci.yml`
- 变更范围检查：
- `git diff -- .github/workflows/ci.yml`
- 推送后：
- `gh run list`
- `gh run watch`
