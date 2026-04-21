# Personal History Project: Session Handoff

## Current Status
- **Branch:** `POC` (Rebuilding from scratch to fix "Real World" verification issues).
- **Core Concept:** A software-agnostic, Git-like, time-based reputation ledger.
- **Key File:** `poc_ledger.py` (A simplified, ~150 line implementation of the entire lifecycle).

## Progress Made
1.  **Architecture Defined:**
    - **Capture Phase:** Encrypt `startTime` and `stopTime` using **GPG** (asymmetric encryption) before any hashing.
    - **Integrity Phase:** Hash the resulting JSON object (containing encrypted blobs) to create a "sealed" entry.
    - **Staging Phase:** Entries live in a local `staging.json` where the user can review, delete, or privatize them before the final commit.
    - **Sync/Commit Phase:** Aggregate a day's habits, hash the entire block, and link it to the `prev_hash` of the previous day.
2.  **POC Script (`poc_ledger.py`) Features:**
    - Uses system GPG automatically (respecting `.zshrc` or default settings).
    - Implements deterministic hashing (`sort_keys=True`) to ensure files verify consistently.
    - Successfully verified the "Real World" loop: Add -> Sync -> Verify.

## How to Resume
1.  **Activate Environment:** Ensure you are in the `POC` branch.
2.  **Test the Loop:**
    ```bash
    python3 poc_ledger.py add     # Add "Reading"
    python3 poc_ledger.py sync    # Commit the day
    python3 poc_ledger.py verify  # Check the math
    ```
3.  **Data Locations:**
    - `~/.config/personal_history_poc/staging.json` (The local DB)
    - `~/.config/personal_history_poc/ledger.json` (The "Blockchain")

## Next Steps
- [ ] **Duration Consistency:** Add logic to ensure habits don't overlap (current `add` defaults to 2-minute duration).
- [ ] **Reputation Summary:** Write a script to sum up `duration` fields across the ledger without decrypting the times.
- [ ] **Digital Signatures:** Incorporate `gpg --sign` into the `sync_day` process to prove the user's identity.
- [ ] **Refactoring:** Once the POC is solid, migrate these simplified patterns back into the main `ph/` package structure.

---
*Created on 2026-04-20 - Gemini CLI*
