# OpenCode Model Routing

## Rule

Select models by task difficulty only. Task type does not create a persistent agent role. Before every creation, use Paseo discovery to verify that the provider, model, mode, thinking option, and requested features remain available.

## Difficulty levels

### Simple

Use when the objective is explicit, low risk, short-context, and has one obvious deliverable with little cross-file reasoning.

- Primary: `opencode/opencode/deepseek-v4-flash-free`
- Primary thinking: `max`
- Fallback: `opencode/opencode/mimo-v2.5-free`
- Fallback thinking: `max`

### Medium

Use for normal research, implementation, planning, testing, design, or single-area review that requires several judgments and validation steps.

- Primary: `opencode/openai/gpt-5.6-luna`
- Primary thinking: `high`
- Fallback: `opencode/openai/gpt-5.6-terra`
- Fallback thinking: `medium`
- Local caveat: Luna previously completed a handshake without an effective response, so accept it only when the response is non-empty and verifiable.

### Hard

Use for cross-module reasoning, ambiguous requirements, architecture, complex debugging, conflicting evidence, or high-impact changes.

- Primary: `opencode/openai/gpt-5.6-terra`
- Primary thinking: `medium`
- Fallback: `opencode/openai/gpt-5.6-luna`
- Fallback thinking: `high`

### Ultra-hard

Use only for exceptional tasks whose correctness depends on sustained repository-wide reasoning, multiple interacting safety invariants, or resolving deeply conflicting evidence that a hard task and focused retries could not settle.

- Primary: `opencode/openai/gpt-5.6-sol`
- Primary thinking: `medium`
- Fallback: `opencode/openai/gpt-5.6-terra`
- Fallback thinking: `medium`

## Selection and fallback

1. Choose the lowest difficulty that safely fits the task.
2. Verify the primary model and thinking option with Paseo discovery.
3. Use the fallback only when the primary is unavailable, errors, produces no effective response, or a focused retry cannot address the failure.
4. Escalate difficulty when failures show that the reasoning requirement was underestimated.
5. Reserve Sol for tasks classified as ultra-hard; do not use it merely because a task is important or high risk.
6. Apply thinking by model: DeepSeek and MiMo use `max`, Luna uses `high`, and Terra and Sol use `medium`. If discovery does not expose the required thinking option for a model, do not silently lower or omit it; choose another valid route and record the reason.
7. Every Worker must self-review its files, scope compliance, and validation evidence before completion; the coordinator must directly inspect those artifacts for final acceptance.
8. For high-risk work, the coordinator may require additional validation from the same Worker but must not dispatch a separate reviewer unless the user explicitly requests independent review in the current request.
9. Record difficulty, model, thinking, and selection reason in every dispatch.
