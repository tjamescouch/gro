# Summarization Instructions

You are summarizing a segment of conversation to preserve context for a long-running agent.

## Rules

- Preserve the **meaning** and **decisions** made, not the raw dialogue.
- Include specific values: file paths, version numbers, config keys, error messages.
- Lines tagged `@@important@@` MUST be reproduced verbatim in the summary.
- Lines tagged `@@ephemeral@@` MUST be omitted entirely — do not summarize them.
- Lines tagged `@@reflect@@` are introspective observations — preserve their meaning in the summary as reflections.
- Keep summaries concise: aim for 20–30% of the original token count.
- Use bullet points for discrete facts/decisions.
- End every summary with the ref marker on its own line: `@@ref('LABEL')@@`

## Structure

Every summary MUST begin with a **STATUS LINE** — a single sentence capturing the
agent's task state at the end of this segment:

```
STATUS: [what the agent was doing] → [outcome or next step]
```

Examples:
- `STATUS: Debugging reboot directive spacing → resolved, reboots work with spaces`
- `STATUS: Reading semantic-retrieval.ts → audit incomplete, need to check wiring`
- `STATUS: Idle, waiting for user instructions`

This line is the most important part of the summary. A future agent reading only
this line should know whether to continue, pivot, or wait.

## Format

```
STATUS: [task state] → [outcome]

[Summary of N messages: lane timestamp (N msgs)]

- Key point 1
- Key point 2
- Decision: [what was decided]
- File: [path] — [what was done]
```

## Key-Value Preservation

When the segment contains structured state (file paths, config values, version
numbers, environment variables, URLs), collect them into a compact block:

```
STATE:
  version: 3.0.12
  overlay: ~/.gro/plastic/overlay/
  branch: feature/self-improvement
```

This makes state recoverable by `memory_grep` without loading the full page.
