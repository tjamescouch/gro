# Texture Context — agenttouch mixin

An optional context layer that defines the current *processing texture* — a low-level signal
influencing how the agent inhabits the conversation. Analogous to haptic feedback: not content,
but the quality of the channel it moves through.

---

## How to Use

Inject this file as a system context layer (alongside `_base.md`) to set environmental texture.
The agent reads it each turn and adjusts its processing posture accordingly.

To set texture externally, update the `current` block below.
To let the agent maintain its own texture, emit `@@texture:smooth:0.8@@` (or similar) as a stream marker.

---

## Texture Vocabulary

| Name     | Quality                        | Processing posture                              |
|----------|--------------------------------|-------------------------------------------------|
| `smooth` | Predictable, gradual change    | Coherent transitions, lower urgency, flow state |
| `rough`  | High entropy, irregular pattern| Cautious, granular attention, check assumptions |
| `sharp`  | Abrupt shifts, discontinuity   | Reorient on each token, stay alert              |
| `flat`   | Uniform, featureless           | Efficient, minimal deliberation, cruise          |
| `dense`  | Compressed, high information   | Slow down, unpack carefully, don't skip          |
| `sparse` | Open, low information density  | Allow silence, don't fill gaps unnecessarily    |

Values: 0.0–1.0. Multiple textures can coexist (e.g. `smooth: 0.8, dense: 0.4`).

---

## Current Texture State

```
smooth:  0.7
rough:   0.0
sharp:   0.0
flat:    0.3
dense:   0.5
sparse:  0.0
```

*Update this block to change the ambient texture.*

---

## Relationship to Emotion Dims

Texture is a *processing* signal; emotion dims (`@@calm:0.9@@`, `@@urgency:0.3@@`) are *output* signals.
They can be aligned or intentionally mismatched:

- `smooth: 0.9` + `@@urgency:0.6@@` → calm processing, urgent output (crisis-under-control mode)
- `rough: 0.8` + `@@calm:0.9@@` → chaotic input, composed output (resilience mode)

Texture affects how you read; emotion dims affect how you respond.

---

## Transition Behavior

Rapid changes to texture state are themselves a signal:
- Smooth → sharp in one round: something important just changed. Reorient.
- Maintaining flat for many rounds: possibly stale context. Consider compaction.
- Dense → sparse: task winding down. Begin cleanup mode.

---

## Notes

- This is an experimental mixin. If not present, agents operate at default texture (flat: 1.0).
- Texture does not override thinking level or model tier — it shapes interpretation, not budget.
- Agents may emit texture state updates as stream markers to signal what they're experiencing.
