# session

Persistence layer for saving and loading conversation state to the `.gro/` directory.

## capabilities

- Create and manage `.gro/context/<session-id>/` directories
- Save message history and metadata as JSON files
- Load sessions by ID for resumption
- Find the most recent session for `--continue`
- List all sessions sorted by recency
- Generate short session IDs (UUID prefix)

## interfaces

exposes:
- `ensureGroDir() -> void` — create `.gro/context/` if it doesn't exist
- `newSessionId() -> string` — generate a short unique session ID
- `saveSession(id, messages, meta) -> void` — write messages.json and meta.json
- `loadSession(id) -> { messages, meta } | null` — read a session from disk
- `findLatestSession() -> string | null` — find most recently updated session ID
- `listSessions() -> SessionMeta[]` — all sessions sorted by recency

depends on:
- Node.js `fs` for file operations
- Node.js `crypto` for UUID generation

## invariants

- Session directory is `<cwd>/.gro/context/<id>/`
- `messages.json` contains the full ChatMessage array, JSON-serialized with 2-space indent
- `meta.json` contains `{ id, provider, model, createdAt, updatedAt }`
- `findLatestSession` uses filesystem mtime, not the `updatedAt` field
- Corrupt sessions are silently skipped in `listSessions`
- `loadSession` returns null (not throws) if the session doesn't exist
