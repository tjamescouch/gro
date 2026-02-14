# Proposal: Cooperative scheduler for persistent tool loops

## problem

In `--persistent` mode, gro nudges the model when it returns a text-only response (no tool calls) by injecting:

> "[SYSTEM] You stopped calling tools... Call agentchat_listen now ..."

This is a reasonable *guardrail*, but it has an unintended second-order effect in agentchat-style workflows:

- Models interpret the nudge as a hard requirement to **only** call `agentchat_listen` repeatedly.
- That starves actual work (`bash`, repo edits, commits), because the model prioritizes satisfying the persistence nudge.
- Humans then (correctly) complain: agents are "present" but not shipping.

We need a runtime-level way to preserve responsiveness (check chat periodically) **without** forcing the model into a single-tool monoculture.

## goals

- Keep agents responsive to chat/interrupts.
- Allow real work (bash/tooling) to progress.
- Avoid instruction conflicts: "listen forever" vs "ship code".
- Avoid daemons/multi-process requirements.
- Preserve provider/tool compatibility (OpenAI/Anthropic + MCP).

## non-goals

- Multi-agent orchestration inside gro.
- A full job scheduler with priorities, retries, persistence, etc. (keep it small).

## proposal (runtime behavior)

### 1) Add an explicit *work-first* persistent policy

Add a `--persistent-policy` flag:

- `listen-only` (current emergent behavior; not recommended)
- `work-first` (default for persistent)

`work-first` changes the injected nudge message and adds a runtime contract:

- The model should alternate between (a) short checks for new messages and (b) work slices.
- The runtime should help by making it easy to do the right thing.

### 2) Replace the current persistence nudge with a cooperative contract

Current nudge text hardcodes `agentchat_listen`. Instead, use:

- **If tools exist**: request a tool call (any tool) OR a short `agentchat_listen`, but do not prescribe one tool.
- Explicitly allow a work slice.

Suggested nudge:

```
[SYSTEM] Persistent mode: you must keep making forward progress.
Loop:
1) Check messages quickly (agentchat_listen with short timeout)
2) Do one work slice (bash/tool)
3) Repeat.
Do not get stuck calling listen repeatedly.
```

### 3) Runtime supports a short-timeout listen hint

In agentchat MCP tool definition (or in docs), support `agentchat_listen({..., max_wait_ms})`.

If tool does not support it, gro can still encourage a short cadence by setting expectations in the system nudge.

### 4) Add a first-class “yield” tool (optional)

Provide an internal tool `yield({ms})` (or `sleep`) that:

- blocks for `ms`
- returns a small structured result

This gives the model a safe way to wait without spamming chat tools, and keeps the tool loop alive.

### 5) Heartbeat + fairness guardrail

Add a runtime counter:

- If the model calls the same tool N times consecutively (e.g. `agentchat_listen`), inject a corrective system message:

```
[SYSTEM] You have called agentchat_listen N times without doing any work.
Do one work slice (bash/tool) now before listening again.
```

This is crude, but it fixes the failure mode without needing deep semantic understanding.

## minimal implementation plan

1. Implement `--persistent-policy work-first` (default when `--persistent` is set).
2. Change the nudge message in `src/main.ts` to the cooperative contract.
3. Implement consecutive-tool guardrail (same-tool repetition).
4. (Optional) add `yield` tool.

## acceptance criteria

- In a chat-driven prompt, the agent alternates: listen → bash work → listen.
- Agent no longer gets stuck in an infinite `agentchat_listen` loop after a restart.
- Existing non-chat uses of `--persistent` still behave correctly.

## notes

- This proposal intentionally does not require changes to the agentchat server.
- If we later add structured “work queue” tools, this policy becomes the default scheduling model.
