# Multi-Device Session & Staging Architecture — Design Notes

> Captured 2026-05-04 during an architectural discussion about Portable Export's downstream implications.
> Updated 2026-05-13 — Phase 2 (StagingService + DeviceIdentityProvider + MergeEngine) + Phase 3 (LedgerEngine) + Phase 4 (Sync Orchestrator) complete.
>
> **Status:** Phase 2, Phase 3, and Phase 4 implementation complete. `domain/staging/`, `security/device_identity.py`,
> and `domain/ledger/` are all implemented. See [archive/ARCHITECTURAL_MIGRATION_STRATEGY.md](./archive/ARCHITECTURAL_MIGRATION_STRATEGY.md) for full status.
> The sections below describe the *target* design — some fields (device_id_enc, transitions_enc, blob obfuscation)
> are implemented in Phase 4 (Staging Interaction Flow + Sync Orchestrator, `core/sync/` package).

---

## The Core Tension

Portable Export enables cross-device sharing (laptop ↔ phone ↔ wearable). But staging — the local plaintext scratchpad — doesn't work in a multi-device world:

| Single-device | Multi-device |
|--------------|--------------|
| Staging is local plaintext (`~/.config/.../staging.json`) | Staging must be **shared** across devices |
| No auth needed for `add` (convenience) | Shared staging is an **attack vector** — plaintext is unacceptable |
| One session cache (`/dev/shm`) | Multiple devices need access without stepping on each other |

---

## Design Direction — Timeline Model

**Staging is a timestamped, additive log.** Every entry carries millisecond-precision timestamps and a device attribution. Since real-world tasks don't start/end at the same millisecond on two devices, there are no write conflicts. No session cookie, no mutual exclusion, no eviction.

**The remote blob is the authoritative source.** Local staging is a cache. Every interaction with staging follows:

```
check device_id → re-auth if mismatch → modify local → push to remote → pull remote → local == remote
```

This means offline devices can queue changes locally and push them on reconnect. On pull, the remote blob's entries (from any device) merge into the local cache by timestamp — deterministic and conflict-free.

---

## Resolved Decisions

### Remote Staging Blob (Q5)
**Resolution:** Comprehensive (2026-05-05)

**Transport interface:**
```python
class AbstractStagingTransport(ABC):
    @abstractmethod
    def pull(self, remote_path: str) -> bytes: ...
    @abstractmethod
    def push(self, remote_path: str, data: bytes) -> None: ...
```

Minimal surface — easy to extend later. Git is the first implementation. Multiple transports available via the same interface.

**Blob location on remote:** `staging/blobs/` (clean namespace, room for future aux files).

**Blob structure:**
```
{
  "device_id_enc": "<encrypted opaque device identifier>",
  "staging": { ... entries ... },
  "version": 1
}
```

- `device_id_enc` — identifies the last device that touched staging. Local device checks this on every interaction; re-auth if mismatch.
- `staging` — the current staging entries (entries from all devices, merged by timestamp).

**Blob obfuscation:**
Serialized JSON → pad to next class ceiling (random fill) → encrypt. Fixed-size tiers: 64K / 128K / 256K / 512K (user-configurable). Backward-compatible with unpadded blobs.

**Workflow (nominal case):**
1. User runs `add start` on device A
2. Device ID check: local device_id_enc matches remote → OK
3. Entry appended to local cache → pushed to remote → pulled back → identical
4. Device B starts a new task: device_id_enc mismatch → re-auth → remote blob pulled → local cache updated with all devices' entries → entry appended → pushed

**Offline behavior:**
- Device writes to local cache when offline
- On reconnect: push local entries (appended by timestamp, no conflict)
- If day already committed to ledger: offline entries for that day are discarded with warning

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

**Backward compatibility:** Padding detection checks if decrypted plaintext ends with valid padding. If it doesn't look padded, it's treated as an old unpadded blob.

### Device Identity

**Interface:**
```python
class DeviceIdentityProvider(ABC):
    @abstractmethod
    def get_device_id(self, mk: bytes) -> str: ...
    @abstractmethod
    def get_device_secret(self, mk: bytes) -> bytes: ...
```

`get_device_id()` returns a deterministic, obfuscated device identifier (reveals nothing about the device to an attacker). `get_device_secret()` returns the key used for HMAC attribution proofs.

**Default implementation:** Both derived from the master key — e.g., `HMAC(mk, "device:id")` and `HMAC(mk, "device:secret")`. This means a device doesn't have an identity until the user authenticates on it. Pluggable — paranoid users can swap in a different provider (biometric, TPM-backed, etc.).

### Device Attribution in Entries

Every entry carries:
- `device_id_enc` — Obfuscated device identifier (AES-CTR with unique nonce per entry → same device produces different ciphertext on each entry)
- `transitions_enc` — Optional action trail for multi-device pauses/unpauses/ends:

```json
{
  "title": "...",
  "startTime_enc": "...",
  "endTime_enc": "...",
  "device_id_enc": "<entry creator>",
  "content_hash": "...",
  "transitions_enc": [
    {"action": "pause", "ts_enc": "...", "device_id_enc": "..."},
    {"action": "resume", "ts_enc": "...", "device_id_enc": "..."},
    {"action": "end", "ts_enc": "...", "device_id_enc": "..."}
  ]
}
```

`transitions_enc` is encrypted as a single block. Only decryptable by the authorized user. Useful for investigation — "who paused my running task?" — but invisible to an attacker.

### Offline Sync and Reconciliation (D3)

**Resolution:** No reconciliation needed. The timeline model means entries from different devices are additive and non-conflicting. On reconnect:
1. Push queued local entries to remote blob (appended by timestamp)
2. Pull remote blob → merge into local cache
3. On `sync` (staging → ledger): entries committed to locked days are quietly dropped

### Evicted Device Behavior (Q6)

**Resolution:** No eviction exists in the timeline model. Multiple devices can append entries concurrently. The only check is device_id match on the remote blob (to trigger re-auth if the cached MK is stale), not for exclusion.

### Device Identity Mechanism (Q7)

**Resolution:** `DeviceIdentityProvider` interface with a master-key-derived default. Pluggable for alternate strategies.

---

## Open Questions (Still Deferred)

### Q6. Evicted Device — What Happens to Local Changes?

> **Resolved by timeline model** — see above. No eviction exists.

### Q7. Device Identity

> **Resolved** — `DeviceIdentityProvider` interface with master-key-derived default.

### D3 — Offline Sync & Network Reconciliation

> **Resolved by timeline model** — see above. Entries are additive, no reconciliation needed.

---

## What This Means for the Entry Schema

The entry schema gains three new fields:

```json
{
  "title": "...",
  "startTime_enc": "...",
  "device_id_enc": "<encrypted device identifier>",
  "transitions_enc": "<encrypted action trail>",
  "content_hash": "..."
}
```

- `device_id_enc` — Always present. Unique ciphertext per entry (random nonce each time). Opaque to attackers.
- `transitions_enc` — Present when a task has been paused/unpaused/ended by a different device than the one that started it. Single encrypted block.
- Both are default fields — present from the moment multi-device staging is introduced.

---

## Relationship to Existing Roadmap Items

| Item | Impact |
|------|--------|
| P2 — Portable Export | Segment format must carry device attribution metadata + transitions |
| P3 — Remote Sync (git-based) | Depends on `AbstractStagingTransport` + staging blob format |
| P5 — Mobile POC | Phone must implement `DeviceIdentityProvider` before writing to staging |
| P6 — Wearable POC | Watch may be read-only (blind index), sidestepping complexity |
