# OpenCode Model Routing

## Rule

Select models by task difficulty only. Task type does not create a persistent agent role. Before every creation, use Paseo discovery to verify that the provider, model, mode, thinking option, and requested features remain available.

## Difficulty levels

### Simple

Use when the objective is explicit, low risk, short-context, and has one obvious deliverable with little cross-file reasoning.

- Primary: `opencode/opencode/deepseek-v4-flash-free`
- Primary thinking: `max`
- Fallback: `opencode/opencode/mimo-v2.5-free`
- Fallback thinking: omit `thinkingOptionId` because MiMo exposes no thinking options.

### Medium

Use for normal research, implementation, planning, testing, design, or single-area review that requires several judgments and validation steps.

- Primary: `opencode/openai/gpt-5.6-terra`
- Fallback: `opencode/openai/gpt-5.6-luna`
- Thinking: `medium`
- Local caveat: Luna previously completed a handshake without an effective response, so accept it only when the response is non-empty and verifiable.

### Hard

Use for cross-module reasoning, ambiguous requirements, architecture, complex debugging, conflicting evidence, or high-impact changes.

- Primary: `opencode/openai/gpt-5.6-sol`
- Fallback: `opencode/openai/gpt-5.6-terra`
- Thinking: `medium`

## Selection and fallback

1. Choose the lowest difficulty that safely fits the task.
2. Verify the primary model and thinking option with Paseo discovery.
3. Use the fallback only when the primary is unavailable, errors, produces no effective response, or a focused retry cannot address the failure.
4. Escalate difficulty when failures show that the reasoning requirement was underestimated.
5. Every Worker must self-review its files, scope compliance, and validation evidence before completion; the coordinator must directly inspect those artifacts for final acceptance.
6. For high-risk work, the coordinator may require additional validation from the same Worker but must not dispatch a separate reviewer unless the user explicitly requests independent review in the current request.
7. Record difficulty, model, thinking, and selection reason in every dispatch.
