# Multi-Device Session & Staging Architecture — Design Notes

> Captured 2026-05-04 during an architectural discussion about Portable Export's downstream implications.
> Updated throughout discussion as decisions were made. Paused at Q5.

---

## The Core Tension

Portable Export enables cross-device sharing (laptop ↔ phone ↔ wearable). But staging — the local plaintext scratchpad — doesn't work in a multi-device world:

| Single-device | Multi-device |
|--------------|--------------|
| Staging is local plaintext (`~/.config/.../staging.json`) | Staging must be **shared** across devices |
| No auth needed for `add` (convenience) | Shared staging is an **attack vector** — plaintext is unacceptable |
| One session cache (`/dev/shm`) | Sessions must be **per-device with mutual exclusion** |

---

## Design Direction

**Direction B** — Shared encrypted staging, single active session across devices.

---

## Resolved Decisions

### Session Cookie Model

```
Shared staging (encrypted):
  session_cookie: {
    "device_id": "<unique device identifier>",
    "seq": 0,                        # monotonically increasing
    "issued_at": "<ISO 8601>",
    "expires_at": "<issued_at + user_configured_timeout>"
  }
```

| Rule | Behavior |
|------|----------|
| Auth on device A | Writes cookie with new seq to remote staging → A is active. Pulls remote staging → local cache. |
| Auth on device B | Overwrites cookie with incremented seq → A's next write attempt is rejected (stale seq). |
| Timeout expires | Cookie is stale → re-auth required on next operation. |
| Explicit `logout` | Only clears the cookie on remote staging. Remote staging data is unchanged (already reflects latest writes). |
| Sync (staging → ledger) | Always requires fresh passphrase. Session cache (`/dev/shm`) is bypassed — user must enter passphrase. Warns: "Paused activities will be lost." |
| Offline `view`/`list` | Warns: "Network Unavailable — Local staging only." Displays ledger + local cached staging. |

### Sequence Number for Write Authorization

**Resolution:** Cookie carries a monotonically-increasing sequence number. Every write to remote staging includes the seq. Remote staging rejects writes where the seq doesn't match the current cookie.

```
Step 0: Laptop auths → cookie = {device: "laptop", seq: 5}
Step 1: Laptop reads cookie (seq=5), writes "end Working" with seq=5       → ACCEPTED
Step 2: Phone auths → cookie overwritten to {device: "phone", seq: 6}
Step 3: Laptop (still cached seq=5) writes "end Running" with seq=5        → REJECTED (current is seq=6)
```

**Why this resolves both latency (Q2) and race (Q3):**
- No heartbeat needed. Each operation checks cookie seq — fast, one round-trip.
- The 1-2ms TOCTOU window is eliminated. A stale seq is rejected.
- AI-agent-proof: an AI operating at sub-millisecond speeds cannot race against another device's writes.
- On disconnect: local writes queue up. On reconnect, any seq mismatch ends the session and forces re-auth.

### Offline Behavior (Q1)

**Resolution:** Lenient, with a lock/unlock day distinction.

- **Unlocked day** (not yet synced to ledger): Local cache entries reconcile on reconnection. No data loss.
- **Locked day** (already synced to ledger by another device): Offline-written entries for that day are discarded. CLI prints: *"Warning: N entries for YYYY-MM-DD discarded — day already committed to ledger."*
- Days can span multiple staging sessions. The mechanism handles overlapping staging across multiple days.
- The blind index (`index.json`) is never involved — only contains committed (ledger) entries. No stale cleanup needed.

### Cookie Check Frequency (Q2) & Race Window (Q3)

**Resolution:** Both resolved by sequence numbers (see above). Per-operation cookie check + seq verification. No heartbeat. No time-window caching that would create a detection gap.

### Auth, Logout, and Sync Rules

| Operation | Cookie Check | Remote Staging Interaction | Notes |
|-----------|-------------|---------------------------|-------|
| Auth | Write cookie + seq | Pull remote staging → local cache | Establishes session |
| add / end / pause / unpause | Read & verify seq | Push change to remote staging | Seq must match |
| view / list all | Read cookie + pull | Fetch current remote staging | Offline: local only with warning |
| logout | Clear cookie | No staging push | Remote data already current |
| sync | Requires fresh passphrase | Read remote staging → commit to ledger | Ignores session cache, warns about paused |

### Device ID and Equality Correlation

**Resolution:**
- `device_id` is a **default field in every entry** — never optional. Removes the present/absent signal.
- Uses randomized encryption (AES-CTR with unique nonce each time) — same device produces different ciphertext on different entries.
- For attribution by the authorized user: **keyed-HMAC device proof** per entry:

```
device_proof = HMAC(device_secret, "entry:" + entry_index)
```

| Property | How it's achieved |
|----------|-------------------|
| Uniform per device | Same `device_secret` for all entries from the same device |
| Unique per entry | Different `entry_index` → different HMAC output |
| Opaque to attacker | Random-looking unique value per entry — no two entries correlate |
| Attributable by authorized user | Try each known device's secret → recompute HMAC → match on success |

### Running Task Edge Case

**Resolution via use case:** Laptop tracks "Working" (running) + "Coffee" (ended). User leaves, picks up phone, auths → cookie overwritten → pulls fresh staging → sees "Working" (running) on phone → can end it or add new entries. This is the validated flow.

---

## Open Questions (Deferred)

### Q5. Remote Staging Transport

**Decision:** Git remote as the first implementation. All options should be available long-term via an `AbstractStagingTransport` interface (same pattern as `AbstractLedgerStore` in the current codebase).

```python
class AbstractStagingTransport(ABC):
    def read(self) -> dict: ...
    def write(self, data: dict) -> None: ...
    def claim_session(self, cookie: dict) -> bool: ...
    def verify_session(self, device_id: str, seq: int) -> bool: ...
```

**Multi-staging reconciliation** (user has multiple failover staging areas) is noted but deferred until after mobile POC (P5) is implemented. Not a roadblock — `MultiStagingTransport` wraps the same `AbstractStagingTransport` interface, no existing code changes needed.

### Staging Obfuscation

**Decision:** The staging blob pushed to the git remote must be obfuscated (otherwise the remote is an attack vector for habit profiling).

**Mechanism — Fixed-size padded encryption:**

```
Serialized staging JSON → pad to next class ceiling (random fill) → encrypt → push to git
```

**Tiered classes** (default, user-configurable):

| Class | Max plaintext data |
|-------|-------------------|
| 64K | Very light usage |
| 128K | Light usage |
| 256K | Moderate usage |
| 512K | Heavy usage (with lengthy comments) |

Random filler bytes pad the actual data up to the class ceiling. The encrypted blob on the remote is always the same size for a given class. An attacker sees only a constant-size binary blob with no timing or volume signal.

**Cross-class transition:** When staging grows beyond the current class, the blob size changes (e.g., 64K→128K). This leaks one bit: a threshold was crossed. Acceptable — once in a new class, daily size is stable again.

**Backward compatibility:** Padding detection checks if decrypted plaintext ends with valid padding. If it doesn't look padded, it's treated as an old unpadded blob."

### Q6. Evicted Device — What Happens to Local Changes?

When Device A's session is invalidated (evicted) and tries to write:

| Option | Behavior |
|--------|----------|
| Fail + notify | Write rejected, CLI prints "Session invalidated — re-auth required" |
| Queue locally | Write stored in local cache, reconciled on next auth |
| Seamless retry | Auto-re-auth and retry (transparent to user) |

### Q7. Device Identity

How to identify a device:

| Option | Description |
|--------|-------------|
| New concept | Generated on first use per device (e.g., `/etc/machine-id` analog), stored locally |
| Tied to ledger identity | Derived from identity key (e.g., `HMAC(identity_secret, "device:laptop")`) — only an authenticated session can derive it |
| Simple | Hostname + random nonce generated on first `init` per device |

---

## Open Problem (Identified, Not Yet Discussed)

### D3 — Offline Sync & Network Reconciliation

Identified during Q1 discussion: If a device commits to the ledger while offline (no network), and another device has also committed on the same network — the two ledgers diverge. Next time they connect, reconciliation is needed.

This affects the `sync` command flow and needs its own design discussion.

---

## What This Means for the Entry Schema

If this direction is adopted, the entry schema gains two new fields:

```json
{
  "title": "...",
  "startTime_enc": "...",
  "device_id": "<encrypted device identifier>",
  "device_proof": "<HMAC proof for attribution>",
  "content_hash": "..."
}
```

- `device_id` — Encrypted with the standard scheme (random nonce each time). Reveals nothing to an attacker.
- `device_proof` — Keyed HMAC for device attribution by the authorized user. Also opaque to attackers.
- Both are default fields — present in every entry, from every device, always.

---

## Relationship to Existing Roadmap Items

| Item | Impact |
|------|--------|
| P2 — Portable Export | The segment format must carry device attribution metadata |
| P3 — Remote Sync (git-based) | Shared staging + session cookie over git needs design |
| P5 — Mobile POC | Phone must implement session check + device proof before writing |
| P6 — Wearable POC | Watch may be read-only (blind index), sidestepping session complexity |
