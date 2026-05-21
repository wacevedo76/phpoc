# PHPOC Backlog

## P3 — Remote Sync (git-based) — In Progress

### Done
- [x] All design questions resolved (Q1-Q11)
- [x] `GitStagingTransport` implementation (pull/push/clone/retry/auth)
- [x] Blob obfuscation (4-tier pad + HMAC sub-key encryption)
- [x] 37 transport/obfuscation tests
- [x] CLI wiring: config → transport → device provider → service
- [x] Config comment stripping
- [x] Auto-push after write commands
- [x] `GIT_TERMINAL_PROMPT=0` — no credential prompts
- [x] Remote URL sync with clone
- [x] Graceful empty-repo handling
- [x] Pull+merge on view (read-only)
- [x] Duplicate task ID fix in view
- [x] Auth-only push retry (not for permission errors)
- [x] `pull()` fallback to `crypto.master_key` for deobfuscation
- [x] **Sync optimization**: stable entry IDs (UUID per entry)
- [x] **Sync optimization**: single-pull `check_and_sync()` (1 pull instead of 3)
- [x] **Sync optimization**: freshness-based pull skip (`_last_push_at`, `_needs_full_pull`)
- [x] **Sync optimization**: merge engine dedup by `entry_id` (backward compat fallback)
- [x] 24 new optimization tests (1049 total, all passing)

### Remaining (Blocked by SSH/auth setup across machines)
- [ ] Cross-device sync test (laptop ↔ debagent04)
- [ ] Handle case where `~/.local/share/phpoc/` doesn't exist yet on pull
- [ ] First-time `phpoc view` on a machine with no local staging
