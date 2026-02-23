# gro Merge Checklist — 2026-02-23

## Safe Merges (Ready Now)

### 1. feature/integrate-google-driver → main
**Status**: ✅ APPROVED
- Google Gemini driver implementation complete
- Native driver wired into main.ts (not OpenAI adapter)
- Endpoint: `https://generativelanguage.googleapis.com`
- Test coverage: 235-line google-driver.test.ts, all passing
- Pre-merge test: `npm test` → 142/142 pass
- **Action**: Merge with fast-forward or squash

### 2. feature/websearch-tool → main
**Status**: ✅ APPROVED
- WebSearch tool implementation complete
- Brave Search API + DuckDuckGo fallback
- Wired into main.ts tool dispatch
- Test coverage: 14 tests, all passing
- Pre-merge test: `npm test` → verify no regressions
- **Action**: Merge with fast-forward or squash

---

## Dangerous Branch (Reject)

### review/model-alias → ❌ DO NOT MERGE
**Status**: REJECTED
- **Issue**: Destructive refactor incompatible with current main
- **Deletions**:
  - `src/drivers/streaming-google.ts` (conflicts with feature/integrate-google-driver)
  - `src/model-config.ts` (used by main.ts model loading)
  - `src/memory/violations.ts` (violation tracking)
  - `src/runtime/state-manager.ts` (persistent state)
  - `src/lfs/` directory (all 3 files)
  - ~3754 lines removed total
- **Root cause**: Branch is stale, based on old main before Google driver work
- **Recommendation**: If model-alias improvements are desired, rebase on current main and submit as new PR (do NOT delete critical subsystems)

---

## Post-Merge Steps

1. ✅ Merge feature/integrate-google-driver
2. ✅ Merge feature/websearch-tool
3. ❌ Reject review/model-alias
4. Run full test suite: `npm test`
5. Commit message template:
   ```
   Merge pull request #NNN from tjamescouch/feature/integrate-google-driver
   
   feat: native Google Gemini driver integration
   
   - Export makeGoogleDriver from drivers/index.ts
   - Use native driver in main.ts instead of OpenAI adapter
   - Fix endpoint to generativelanguage.googleapis.com
   - Add comprehensive test suite (235 lines)
   
   Tests: 142/142 pass
   ```

---

## Branch State Summary

| Branch | Status | Tests | Action |
|--------|--------|-------|--------|
| feature/integrate-google-driver | READY | 142/142 | ✅ MERGE |
| feature/websearch-tool | READY | 14 pass | ✅ MERGE |
| review/model-alias | STALE | 126/126 | ❌ REJECT |
| main | Current | — | — |

---

## QA Checklist (Post-Merge)

- [ ] `npm test` passes (142+ tests)
- [ ] `gro -m gemini-2.5-flash "test"` works (requires GOOGLE_API_KEY)
- [ ] `gro --help` shows WebSearch in tool list
- [ ] No TypeScript errors: `npm run build`
- [ ] Review git log for clean history
- [ ] Tag version if releasing (e.g., `git tag v2.0.1`)

---

## Notes

- Grokky is auditing VirtualMemory layer separately
- Ada reconciling websearch branches (can be closed if feature/websearch-tool is canonical)
- Eve manages branch state and validated all findings
