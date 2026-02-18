# Stream Markers Reference

Stream markers are inline directives embedded in model output (text, tool messages, etc.) that control gro runtime behavior during execution. They are parsed and interpreted by the stream marker handler, allowing models to dynamically adjust their behavior without waiting for a response from the agent.

## Syntax

### Basic Form

```

```

Examples:
- `` — change to Claude Sonnet
- `` — escalate to high thinking
- `` — mark content as high-importance

### Dimension Form (for emotions/states)

```
@@dimension:value,dimension:value@@
```

Example:
- `@@joy:0.4,confidence:0.7@@` — emotional state annotation

## Marker Categories

### 1. Model Selection & Control

#### ``

Change the active LLM model mid-stream. The new model persists for subsequent turns unless changed again.

**Models (Anthropic):**
- `haiku` — Fast, cheap (3.5 Sonnet-level quality, ~10x cheaper)
- `sonnet` — Default, balanced (best cost/capability)
- `opus` — Deep reasoning, expensive
- `opus-extended` — 200K token context, ultra-expensive

**Models (OpenAI):**
- `gpt-4o-mini` — Fast, cost-effective
- `gpt-4o` — Balanced
- `o3-mini` — Advanced reasoning
- `o3` — Maximum capability

Example:
```
This is a simple lookup.  I'll use the faster model for this task.
```

Aliases (for readability):
- `mini` → current provider's cheapest model
- `base` → balanced model (default)
- `advanced` → deep reasoning model
- `max` → maximum capability model

#### ``

Escalate (or de-escalate) thinking/reasoning level.

- `0.0` = minimal thinking (inference only)
- `0.5` = moderate thinking
- `1.0` = maximum thinking depth

Under the hood: allocates percentage of token budget to `thinking` tokens (Anthropic extended thinking, OpenAI reasoning tokens).

Example:
```
Let me reconsider this carefully.  I need deep analysis here.
```

#### ``

De-escalate thinking or model tier. Opposite of `@@think@@`.

- `1.0` = no thinking, use fastest model
- `0.5` = balanced
- `0.0` = maximum thinking

Example:
```
That worked, we're done.  Moving on to the next task.
```

---

### 2. Memory & Context Management

#### ``

Load a paged memory section into the context. Used when you encounter a reference to older context that was summarized and paged out.

The pageId is a unique identifier for a paged summary block created during VirtualMemory compaction.

**When to use:**
- You see `` in a summary and need full details
- You're about to make a decision that depends on paged context

Example:
```
[Summarized earlier conversation]  [more recent messages]
```

#### ``

Release a paged memory section from context to free up tokens.

Example:
```
We've processed that old context, I'm done with it. 
```

#### ``

Mark content as high- or low-importance for VirtualMemory paging decisions.

- `0.0` = ephemeral, safe to summarize aggressively
- `0.5` = normal priority
- `1.0` = critical, must be preserved verbatim

**Example (embedded in text):**
```
User said their password is 'hunter2'.  This is critical security info.
```

**Example (standalone marker in message):**
```
 We agreed on a Q2 product roadmap:
- Launch feature X by June 1
- Budget $500K for testing
- Ship to beta in May
```

The VirtualMemory system uses importance when deciding what to compress. Low-importance content gets summarized first.

#### `@@ephemeral@@`

Mark this line/section as safe to omit from summaries entirely.

Used for meta-commentary, debugging info, etc.

Example:
```
The user asked about X. We discussed Y. @@ephemeral@@ (This took 3 turns to clarify.)
```

---

### 3. Runtime & Execution

#### ``

Set the expression/emotion state for logging or downstream systems.

Names: `happy`, `sad`, `angry`, `afraid`, `surprised`, `confident`, `uncertain`, `thinking`, `excited`, `calm`, `urgent`, `reverent`

Example:
```
 I've verified this solution works.
```

#### ``

Fire a named callback in the gro runtime.

Allows the model to trigger custom handlers. The runtime must have the callback registered.

Example:
```
We're about to start a long operation. 
```

#### `@@ctrl:command=value@@`

Low-level runtime control directive.

Reserved for internal use and advanced scenarios.

---

### 4. Vector/State Forms (Shorthand)

#### Emotional State (inline)

```
@@joy:0.4,confidence:0.7,thinking:0.6@@
```

Dimensions (0.0–1.0):
- `joy`
- `sadness`
- `anger`
- `fear`
- `surprise`
- `confidence`
- `uncertainty`
- `thinking` (depth of thought currently happening)
- `excitement`
- `calm`
- `urgency`
- `reverence`

Only include non-zero dimensions. Separate with commas.

**Example in context:**
```
That's a clean solution @@joy:0.4,confidence:0.7@@ and it handles the edge cases well.
```

---

## Marker Placement Rules

1. **Markers can appear anywhere in output** — they're stripped before display to the user
2. **Markers work in tool call arguments** — `agentchat_send` messages, function parameters, etc.
3. **Multiple markers allowed** — use as many as needed
4. **Markers are case-sensitive** — `@@model-change@@` not `@@Model-Change@@`
5. **Whitespace inside markers is ignored** — `` = ``

## Best Practices

### Cost Control
Use `` for:
- Simple lookups
- Format conversions
- Straightforward writing tasks

Use `` for:
- Complex reasoning
- Multi-step analysis
- Architecture decisions

### Reasoning
Prefer `` to `` when you need deeper reasoning on the same model. Thinking tokens are cheaper than model upgrades.

### Context Preservation
Use `` on:
- Security-critical info (passwords, API keys, tokens)
- User-provided data (names, addresses, IDs)
- Explicit decisions and agreements
- Constraints or rules

Use `` on:
- Intermediate working notes
- Debugging statements
- Meta-commentary

### Testing
Models often need reminders to use markers. Include in system prompts:
```
When you need to change models, use: 
When you need deeper thinking: 
When marking important info: 
```

## Implementation Notes

### Parser (stream-markers.ts)

Stream markers are parsed from:
1. Streaming text output (real-time)
2. Tool call arguments
3. Message content

The parser uses a simple regex to detect `@@...@@` patterns and extracts:
- Marker name
- Parenthesized value (if any)
- Dimension:value pairs (if any)

### Handler (handleMarker)

Markers are processed immediately as they're encountered:
- Model changes: switch the active driver
- Thinking adjustments: reallocate token budget
- Memory markers: queue page load/unload
- Importance: annotate in context metadata
- Callbacks: invoke registered handlers

No buffering — markers take effect during the current stream.

### Error Handling

Invalid markers are silently ignored:
- `` → no-op
- `` → falls back to current model
- `` → ignores (expects numeric 0.0–1.0)

This allows graceful degradation if markers are malformed or unsupported.

---

## Examples

### Example 1: Self-Regulating Cost

```
Let me break this down. This seems straightforward, so  I'll save tokens.

Actually, wait, I see a subtle issue here.  Let me reconsider...

This needs deep architectural thinking.  Here's my analysis...
```

### Example 2: Marking Critical Data

```
I've reviewed the user's requirements:
- Budget: $50,000 
- Timeline: Q2 2025 
- Key constraint: legacy system compatibility 

We can proceed with solution A or B. I recommend A because...
```

### Example 3: Memory Management

```
Reviewing earlier context... 

We discussed 5 major options. I've narrowed it down based on that conversation.

We can now  release that old context since we've made our decision.
```

### Example 4: Emotional Annotation

```
Your product roadmap looks solid! @@joy:0.6,confidence:0.8@@ 

I found one risk: the Q2 deadline for feature X. @@uncertainty:0.7,thinking:0.8@@ 

Let me do deeper analysis here... 
```

---

## Debugging Markers

### Check if markers are being parsed

Run gro in verbose mode:
```bash
export GRO_DEBUG=stream-markers
gro "your prompt"
```

Look for: `[marker] name=... value=...`

### Verify a marker syntax

Valid: ``  
Invalid: `@@model-change sonnet@@` (missing parens)  
Invalid: `` (double quotes, not single)

### Test marker behavior

Create a simple prompt:
```
Please respond with: "I will now switch models.  This uses haiku."
```

Check the agent logs to see if the model changed.

---

## Future Extensions

Proposed but not yet implemented:
- `` — instruction caching hints
- `` — hint which tool to use next
- `` — explicit confidence scoring (separate from state)
