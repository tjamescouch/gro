# 3D Avatar Integration Plan

## jc's Request
"Get the 3D avatar working once everything is stable"

## Investigation Needed
1. Find existing avatar code in gro or related repos
2. Check if there's a TUI layer that could host a WebGL canvas
3. Identify what "3D avatar" refers to — likely a visual representation in the terminal or a web UI

## Approach Options

### Option A: Terminal ASCII/Unicode Avatar
- Use blessed/ink-style rendering in the TUI
- Animated ASCII art character that reacts to agent state
- Cheapest to implement, no dependencies

### Option B: Web UI with Three.js
- Spin up a local Express server alongside gro
- Serve a minimal Three.js page
- Agent pushes state (emotion dims) to the web page via WebSocket
- Avatar reacts to `@@calm@@`, `@@confidence@@`, etc. emotion markers

### Option C: VRM Avatar (Ready Player Me)
- Load a .vrm file into a Three.js scene
- Map gro emotion dims to blend shapes
- Stream-markers like `@@joy:0.8@@` drive facial expressions in real-time

## Recommended: Option B (Web UI + Three.js)
Low friction, doesn't block terminal, reuses emotion dim system already in gro.

## Next Steps
- [ ] Check if gro has any existing web server / TUI code
- [ ] Find if there's a `~/avatar/` or `~/gro/src/tui/` with relevant code
- [ ] Prototype: simple Express server + Three.js box that pulses on emotion change
- [ ] Wire to gro stream-markers parser

## Files to Check
- `~/gro/src/tui/` — terminal UI code
- `~/gro/src/stream-markers.ts` — emotion dim parsing
- Any existing web server setup in gro
