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
- [x] 1022 tests total, all passing

### Remaining (Blocked by SSH/auth setup across machines)
- [ ] Cross-device sync test (laptop ↔ debagent04)
- [ ] Handle case where `~/.local/share/phpoc/` doesn't exist yet on pull
- [ ] First-time `phpoc view` on a machine with no local staging
