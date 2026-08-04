# Plan: CLI Read Commands Should Pull Remote Even on Specifier Mismatch

> **Status:** 🔜 Planning
> **Created:** 2026-06-29
> **Problem:** CLI read-only commands (`ph view`, `ph list`, `ph tag`) block entirely when another device holds the staging cookie, instead of silently pulling and showing the latest data.

---

## Symptom

```
Web app writes task → pushes blob + cookie → 
CLI `ph view` → check_and_sync() → specifier mismatch → REAUTH_NEEDED →
_sync_before_command(require_auth=False) → 
  "Remote staging is held by a different device." → returns False →
view_active() → returns early → shows NOTHING (not even local data)
```

The user runs a harmless read command and gets locked out. The data exists on R2 — the CLI just refuses to look at it because someone else "owns" the cookie.

## Root Cause

`_sync_before_command` in `phpoc_cli/interface.py` treats `REAUTH_NEEDED` as a hard block for all commands, including reads:

```python
# phpoc_cli/interface.py line 27
def _sync_before_command(self, require_auth: bool = False) -> bool:
    result = self._staging.check_and_sync(timeout_ms=500)

    if result == SyncCheckResult.READY:
        return True
    if result == SyncCheckResult.OFFLINE:
        return True  # Continue with local data

    if result == SyncCheckResult.REAUTH_NEEDED:
        if not require_auth:
            print("\nRemote staging is held by a different device.")
            print("Please re-authenticate to access remote staging.")
        return False  # ← HARD STOP for ALL commands

    return True
```

And callers like `view_active()` bail immediately:

```python
# phpoc_cli/interface.py line 239
def view_active(self, ...):
    if not self._sync_before_command(require_auth=False):
        return  # ← Shows nothing, not even local data
```

This conflates two different things:
1. **Can I write to staging?** → Need cookie ownership → REAUTH_NEEDED is correct
2. **Can I read from staging?** → Just need to see the latest data → should pull remote, merge, show

## Design: Read vs Write Sync

The CLI already has `require_auth=False` for read commands. The problem is that `REAUTH_NEEDED` is treated identically regardless of `require_auth`.

### Proposed: `check_and_sync_readonly()` — a lightweight variant

Add a new method to `StagingService` that pulls remote blob WITHOUT claiming ownership (no cookie push, no specifier update):

```python
def check_and_sync_readonly(self, timeout_ms=500):
    """Pull remote staging blob, merge with local, but DON'T claim ownership.

    For read-only commands (ph view, ph list, ph tag). The caller wants to
    see the latest data from remote but NOT take over the cookie.

    Returns:
        SyncCheckResult.READY on success (data merged),
        SyncCheckResult.OFFLINE on network failure (continue with local only).
        REAUTH_NEEDED should NOT be returned — reads don't require ownership.
    """
    if self._remote is None:
        return SyncCheckResult.READY

    # Try to pull remote blob (doesn't need cookie match)
    try:
        remote_blob = self._remote.pull(master_key=mk)
    except Exception:
        return SyncCheckResult.OFFLINE

    if remote_blob and "entries" in remote_blob:
        # Merge remote into local (don't push back)
        local_entries = self._local.read_entries()
        merged = self._merge.merge(local_entries, remote_entries)
        self._local.write_entries(merged)

    return SyncCheckResult.READY
```

### Why not just use the existing path with a flag?

The existing `check_and_sync()` flow is:
```
cookie check → fast path → auth gate → reconcile_and_claim
```

We could add a `read_only=True` parameter that short-circuits the specifier mismatch check and goes straight to pulling+merging. But this adds complexity to an already-complex method. A separate `check_and_sync_readonly()` is simpler to reason about and test.

### Who calls it?

| CLI Command | Old behavior | New behavior |
|---|---|---|
| `ph view` | `_sync_before_command(require_auth=False)` → blocked on mismatch | `_sync_before_command_readonly()` → pulls remote, merges, shows data |
| `ph list` | same | same fix |
| `ph tags` | same | same fix |
| `ph start` | `_sync_before_command(require_auth=True)` → blocked on mismatch (correct) | No change — write commands still require re-auth |
| `ph end` | same | No change |
| `ph log` | same (write) | No change |

### `_sync_before_command` changes

The simplest approach: add a `_sync_before_command_readonly` variant, and redirect read commands:

```python
def _sync_before_command_readonly(self) -> bool:
    if self._staging._remote is None:
        return True

    result = self._staging.check_and_sync_readonly(timeout_ms=500)
    if result == SyncCheckResult.READY:
        return True
    if result == SyncCheckResult.OFFLINE:
        return True  # Continue with local data
    return True
```

**Always returns True** — it never blocks. Worst case: network error → show stale local data. Better than showing nothing.

### `check_and_sync_readonly()` implementation notes

1. **Master key retrieval:** Needs access to `CryptoManager.master_key`. For read commands, the MK is typically cached (from a previous `ph login` or `ph view` auth). If not cached, the blob can't be deobfuscated → fall back to local data.

2. **No cookie check:** Skip the entire cookie fast-path/auth-gate machinery. Go straight to pull-merge-show.

3. **No push back:** Critically, do NOT push the merged result to remote. That would claim ownership. The CLI is being a polite observer.

4. **Offline handling:** If the remote pull fails (network error/timeout), continue with local data. The 500ms timeout prevents hangs.

5. **Wrong master key:** If `pull()` returns `BLOB_KEY_MISMATCH`, the remote blob exists but can't be decrypted (different seed). Treat as OFFLINE — show local data.

## Files to Touch

| File | Change |
|---|---|
| `domain/staging/service.py` | Add `check_and_sync_readonly()` method |
| `phpoc_cli/interface.py` | Add `_sync_before_command_readonly()`; redirect `view_active`, `list_entries`, `tag_*` to use it |
| `tests/test_cli_interface.py` | Add tests: read command with specifier mismatch shows data, write command still blocks |
| `tests/test_staging_readonly.py` | (new) Unit tests for `check_and_sync_readonly()` |

## What This Does NOT Change

- **Write commands** — `ph start`, `ph end`, `ph log`, `ph modify`, `ph delete` — still require re-auth on specifier mismatch (correct behavior)
- **Cookie ownership model** — still single-device ownership for writes
- **Remote blob format** — same `staging/blobs/current.json`, same obfuscation
- **Web app** — no changes needed (web app always has the cookie, no read-only mode needed)

## Sequence Diagram

```
┌─────────────────────────────────────────────────────────┐
│ CLI `ph view` (after web app wrote to staging)           │
│                                                         │
│  check_and_sync_readonly()                              │
│    ├─ pullCookie() → device_uuid: "web-app-uuid"        │
│    │   (doesn't matter — we're read-only)               │
│    ├─ pullBlob(mk) → deobfuscate → remote entries       │
│    ├─ read local staging entries                        │
│    ├─ merge(local, remote)                              │
│    ├─ write_entries(merged)  ← local only               │
│    │   (NO pushBlob, NO pushCookie)                     │
│    └─ return READY                                      │
│                                                         │
│  view_active()                                          │
│    ├─ read local staging (now merged)                   │
│    ├─ filter active tasks                               │
│    └─ display → ✅ shows web app's task                  │
└─────────────────────────────────────────────────────────┘
```

## Edge Cases

| Scenario | Behavior |
|---|---|
| CLI has no master key cached | Try to pull raw bytes (plaintext fallback). If obfuscated, show local data only with info message |
| Remote blob is older than local | Merge handles it — local entries win for same-title entries |
| Remote pull times out (500ms) | Continue with local data — better stale than blocked |
| Network completely down | Continue with local data (same as today's OFFLINE path) |
| User is on first-time `ph view` (never onboarded) | No local data, no remote config → no-op, show "No active tasks" |
| CLI has written tasks locally, hasn't pushed yet | Merge combines both local + remote → shows all tasks |

## Relation to Existing Plans

- **STABLE_DEVICE_SPECIFIER_ON_WRITES.md** — Fixes the web app's cookie re-roll, which reduces how often the CLI sees a mismatch. But even with that fix, genuine cross-device scenarios (two different machines) still need this read-only path.
- **ALIGN_WEB_STAGING_SHARING_WITH_CLI.md** — Covers the auth gate + re-auth flow for **write** operations. This plan covers **read** operations with a lighter touch (no auth needed).
