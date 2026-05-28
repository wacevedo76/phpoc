# Remote Staging — Issue Tracking (Compacted)

## Resolved

| Issue | Resolution |
|-------|-----------|
| Specifier mismatch didn't force auth (Issue #23) | `specifier_mismatch` flag bypasses `_is_auth_fresh()` unconditionally |
| Sync pushed device cookie (Issue #19) | `push_blob_only()` extracted; sync uses it |
| Cookie redesign (HMAC→random specifier) | String comparison is definitive across shared-key devices |
| Missing `capture()` calls (Issue #20) | Restored in `add_start`/`add_oneoff` |
| Device UUID provenance (Issue #21) | `device_uuid_enc`/`end_device_uuid_enc` on every entry |
| Cookie not created on slow-path auth (Issue #22) | `_ensure_cookie()` after successful auth+merge |
| Stale-remote resurrection (Issue #15) | `check_and_sync()` removed from all write methods |
| `_last_auth_time=0.0` false REAUTH (Issue #13) | isinstance check on `NoAuthCryptoManager` |
| `ph recover` doesn't clear session (Issue #11) | Fixed in auth module |
| Session cache blocks re-auth (Issue #8) | Fixed |
| `ls-remote` arg order breaks on git 2.53+ (Issue #6) | `--heads` before remote name |
| `ph view` bypassed check_and_sync (Issue #2) | Routed through canonical sync entry |
| HTTP timeout too low (Issue #16) | 10s→60s default |
| 403 bug: urllib header case-mangling | Switched to `http.client` |
| Ledger chain divergence (Issue #17) | `_verify_chain(strict=False)` skips incompatible remote blocks |
| Phase 1 (HTTP transport) | Complete — Worker deployed, ~100ms latency |
| Phases A/B/C | Complete — instant reads, WAL writes, daemon |
| Onboarding | Complete — `ph onboarding` |
| `ph login` auth loop (cookie not cleared) | `DeviceCookie.destroy_locally()` called after `login()` in `main.py` |
| Redundant blob pull before auth gate | Cookie-only fast path → auth → blob ops |
| `_is_auth_fresh()` / `_last_auth_time` removed | Cookie TTL is sole auth freshness check; no CryptoManager consultation |
| `_needs_full_pull()` removed | Device UUID comparison after auth decides pull vs push-local |
| `_deep_merge` shallow-copy bug (P0) | Deep-copy dict values instead of sharing `DEFAULTS` references |
| `ph recover` leaves old chain on remote (Issue #14, P2) | `push_blocks(force=True)` overwrites re-chained blocks after recovery |
| Latency: redundant `list_files()` (P4) | Share `existing_indices` between `pull_blocks()` and `push_blocks()` — saves 1 HTTP call |
| `ph sync remote_staging` ignores check_and_sync | Routing removed — `ph sync` handles re-auth properly |

## Open

*(No open issues — all tracked items resolved.)*

## Device Side-quests

### Hand-off flow (now working)

```bash
# Device A holds staging. On Device B:
ph view       # "held by different device" — blocked
ph login      # authenticate, clears local cookie ✓
ph view       # no local cookie → no specifier_mismatch → auth passes
              # → pull remote blob → merge → create new cookie → READY
```

### Security incident: passphrase exposure (2026-05-22)

**Critical** — passphrase `m0r3m0n3y` committed in two pushed commits via these docs. Remediated via interactive rebase + force push. Passphrase retired, new one set via `ph recover` on both devices. Trace logging now redacts 32-byte keys and sensitive kwargs.

## Design Decisions Archived

### Device Cookie (HMAC → random specifier, 2026-05-27)

HMAC was deterministic — same `(master_key, device_id, epoch_ms)` → identical bytes. Flaw: shared-key devices produce identical HMACs. **Fix:** random specifier on every creation, string comparison is definitive.

### Blob never pulled before auth

Previous design pulled blob in slow path before checking `specifier_mismatch` → wasted 150ms network call. New design: cookie-only fast path → auth gate → blob operations only after auth passes.

### No `_is_auth_fresh()` for auth decisions

Previously consulted CryptoManager presence and `_last_auth_time` TTL. Removed: cookie TTL + specifier comparison are sufficient. No CryptoManager needed for auth gate decisions (still needed for blob decrypt).
