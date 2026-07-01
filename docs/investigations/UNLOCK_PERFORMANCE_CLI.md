# CLI Ledger Unlock Performance Investigation

> **Date:** 2026-07-01 | **Scope:** Python CLI (`main.py` → `security/auth.py` → `domain/staging/service.py` → transport)

## Summary

Unlocking the ledger (passphrase → data accessible) takes 3–15 seconds with a remote Worker configured, and up to 60 seconds when the remote is unreachable. PBKDF2 (600K iterations) is NOT the bottleneck — it completes in ~0.09s via OpenSSL-backed `hashlib`.

## Root Cause 1: Broken HTTP timeout plumbing

The `timeout_ms` parameter is threaded through the API but never actually passed to the network layer.

| Layer | Method | Has `timeout_ms` param? | Passed to transport? |
|---|---|---|---|
| `main.py` | `check_and_sync(timeout_ms=500)` | ✅ | — |
| `domain/staging/service.py` | `check_and_sync(timeout_ms=500)` | ✅ | ❌ Never used |
| `domain/staging/service.py` | `_reconcile_and_claim(mk)` | ❌ | ❌ `pull_cookie()` + `pull()` bare |
| `domain/staging/remote_sync.py` | `pull_cookie()` → `_transport.pull(path)` | ❌ | ❌ |
| `domain/staging/remote_sync.py` | `pull(master_key)` → `_transport.pull(path)` | ❌ | ❌ |
| `core/sync/http_transport.py` | `pull(path, timeout_ms=None)` | ✅ | `timeout_s = 60.0` when None |

**Key code:** `core/sync/http_transport.py:56` — `_DEFAULT_TIMEOUT_S = 60.0`

Even `check_remote_available(timeout_ms=500)` only measures elapsed time after the call completes — it doesn't enforce the timeout on the actual socket:

```python
# remote_sync.py:367
def check_remote_available(self, timeout_ms: int = 500) -> bool:
    start = _time.monotonic()
    result = self._transport.pull(self._blob_path)  # ← 60s timeout!
    elapsed_ms = (_time.monotonic() - start) * 1000
    if elapsed_ms > timeout_ms:
        return False
    return True
```

## Root Cause 2: Multiple sequential network calls during unlock

When `_reconcile_and_claim()` runs (cold session + remote configured), it makes up to 3 sequential HTTP requests, each creating a new TCP+TLS connection (no pooling / no keep-alive):

```
pull_cookie()       → GET  staging/blobs/device_cookie.bin     (60s timeout)
pull(master_key)    → GET  staging/blobs/current.json           (60s timeout, obfuscated blob up to 64KB)
push(merged_entries) → PUT  staging/blobs/current.json           (if merge changed blob)
```

Each request: `http.client.HTTPSConnection(timeout=60.0)` → new `connect()` → TLS handshake → HTTP request.

## Root Cause 3: Read commands make unnecessary network calls

`ph list`, `ph view`, `ph tags` call `check_and_sync()` which enters the fast path and pulls the remote cookie — even when the user only wants to see local data.

```python
# service.py fast path (line ~492)
if local_cookie is not None:
    remote_cookie_raw = self._remote.pull_cookie()  # ← blocks on network
```

## Why "sometimes" 10 seconds?

| Worker state | Cookie pull | Blob pull | Total |
|---|---|---|---|
| Warm (cached edge) | 0.2–0.5s | 0.5–1s | 1–2s ✅ |
| Cold start | 3–5s | 3–5s | 6–10s 🔴 |
| Unreachable | 60s | 60s | timeout |

Cloudflare Workers (free tier) cold-start in 1–5 seconds. The CLI makes 2–3 sequential requests per `_reconcile_and_claim()`, so cold-start latency multiplies.

## What's NOT the bottleneck

| Operation | Measured time |
|---|---|
| PBKDF2-SHA256 600K iterations | 0.09s |
| PBKDF2-SHA256 100K iterations | 0.02s |
| JSON parse ~105 blocks (52KB) | ~0.001s |
| File I/O (read/write ledger.json) | <0.001s |
| LedgerEngine / LedgerDomain construction | <0.001s |
| IndexManager load | <0.001s |
| Chain verification | Not done during unlock |

## Proposed Solutions

### A: Fix timeout plumbing
- Reduce `_DEFAULT_TIMEOUT_S` from 60.0 → 5.0 (or split: 3s connect + 10s read)
- Pass `timeout_ms` through `pull_cookie()`, `pull()`, `_reconcile_and_claim()`
- Fix `check_remote_available()` to actually pass timeout to transport
- **Files:** `core/sync/http_transport.py`, `domain/staging/remote_sync.py`, `domain/staging/service.py`

### B: Pre-check reachability
- Call `check_remote_ping(timeout_ms=1000)` before cookie/blob pull chain
- If unreachable, bail early with `OFFLINE`
- **Files:** `domain/staging/service.py` (in `check_and_sync` fast path)

### C: Skip network for reads
- Add `check_local_only()` method that validates TTL locally, no remote calls
- Use it for `ph list`/`ph view`/`ph tags`; reserve `check_and_sync()` for writes
- **Files:** `domain/staging/service.py`, `main.py`

### D: Connection pooling
- Replace per-request `http.client.HTTPSConnection` with persistent connection
- Or switch to `urllib3`/`requests` with session reuse
- **Files:** `core/sync/http_transport.py`

### E: Worker warmup
- Enable Workers Paid plan (no cold starts)
- Cron trigger to self-ping every 5–10 min
- `warmup` endpoint for CLI/Web to call on startup
- **Files:** `worker/src/index.js`, `worker/wrangler.toml`
