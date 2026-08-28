# Session History — 2026-08-22

## Investigation: "activities through Aug 7 doubled on ledger" (root cause determined)

Workflow: `pm clear` (data wipe) → Restore from Cloud on `emulator-5554`; observed app dataflow end-to-end;
decrypted the full remote R2 chain (134 blocks / 275 entries) from the Worker (reverse-engineered blob format:
HMAC-SHA256 blob key + AES-128-CTR).

### Finding 1 — Source chain carries baked-in historical double-seals (not a restore bug)
The remote ledger has **12 entries that are 2–4× seals of the SAME running activity** — identical `start`
millisecond, different growing `end`:

| Activity (_title_) | Date | Copies | hashes |
|---|---|---|---|
| Working on phpoc | May 18 | ×2 | c5458cad…, ec8bcd59… |
| Working on phpoc | May 18 | ×2 | fadcef21…, 92e110f7… |
| Working on Phpoc | May 22 | ×2 | f41eb116…, 9ad33bb2… |
| Working on Phpoc | May 22 | ×4 | ef38ca29…, 4bdbf4f2…, be74cc43…, 1c4dd125… |
| Working on Phpoc | May 27 | ×2 | 1c97feac…, de525855… |

These are the **oldest committed entries (Apr 23 → Jul) that carry NO `activity_id`** in their sealed data
(only `content_hash`, `startTime_enc`, `endTime_enc`, `title`, …). The engine's **commit path appended a fresh
sealed entry every time a long-running task was committed while active** — same start, larger end — with **no
dedup by (title + start)**. They survive into any restore because they are part of the canonical chain; History
faithfully reflects staging.

### Finding 2 — The full-ledger re-seed doubling is ALREADY FIXED
Earlier buggy app state logged `staging has 502 entries` (~2× the correct 262) = re-import/re-seed doubling of
entries lacking `activity_id` via `generateActivityId()` fallback in `resolveSeedActivityId()`. Resolved by the
dedup fix `commit 2d05aff` (StagingSeedDeduper dedups by hash/entry_id/activity_id).

**Fresh restore with current code:** exactly **262 staging rows**, 0 uncommitted pending; History for
Aug 4/6/7 matches the clean remote (24/13/13 entries). So a clean restore no longer doubles the whole ledger.

### Net conclusion
The user-visible "through Aug 7" full doubling came from the re-seed path (now fixed). The only residual
doubling is the 12-entry historical double-seal concentrated in May. Remediation options:
- (a) one-time data repair: remove superseded duplicate seals per (title,start), keeping the latest end; or
- (b) change the commit path to **update** rather than append an active task's seal when re-committed while running.

Vectors: `verify_ledger.py` can scan for same-start duplicates.

## Credential leak neutralized (working tree)
Per AGENTS.md "No secrets in repo", the hardcoded personal credentials were scrubbed from the working tree:
- `phpoc-flutter/lib/features/onboarding/onboarding_screen.dart` — personal pre-fill removed (fields start empty;
  creds entered at runtime from gitignored `TEST_CREDENTIALS.md`).
- `phpoc-flutter/tool/diag_verify.dart` — reads recovery seed from `PHPOC_RECOVERY_SEED` env var (no hardcoded seed).
- `scripts/fix_chain_genesis_link.py` — example worker-url replaced with `<your-worker>` placeholder.
- `docs/planning/archive/SESSION_HISTORY_2026-08-19.md` — worker-url scrubbed.

The values remain in **committed git history**; truly nullifying the leaked seed requires the **C-2 re-key**
(`SEED_REKEY_C2_PHASE1.md`) and a user-initiated history rewrite.
