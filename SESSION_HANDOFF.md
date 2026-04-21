# Personal History Project: Session Handoff

## Primary Goals
- **Cross-Platform Portability:** The ledger format and logic must work across Linux, macOS, and Windows without complex system dependencies (e.g., preference for Python-native crypto over GPG binaries).
- **Software-Agnostic Format:** The ledger is a plain-text JSON structure that can be verified by any tool following the specification.
- **Privacy-First Reputation:** Encrypt time-sensitive data (start/stop) while keeping non-sensitive metadata (titles, durations) visible for "reputation" aggregation.
- **Low Friction Identity:** Use password-based keys (KDFs) for encryption and integrity to avoid the UX burden of GPG key management.
- **Data Integrity:** Guarantee a chain-of-trust where each day's entry is cryptographically linked to the previous one.

## Current Status
- **Repository:** ~/Gemini/phpoc (New clean-slate POC repo).
- **Core Concept:** A software-agnostic, Git-like, time-based reputation ledger.
- **Key File:** poc_ledger.py (Enhanced with overlap checks and reputation reporting).

## Progress Made (Current Session)
1.  **Migration:** Successfully moved the POC to a dedicated repository for focused development.
2.  **Duration Consistency:** Implemented overlap detection in `poc_ledger.py`.
3.  **Reputation Summary:** Added the `rep` command to aggregate durations across the entire ledger.
4.  **Pure-Python Crypto:** Transitioned from OpenSSL subprocess calls to a custom `crypto_utils.py` providing AES-CTR and PBKDF2. Achieved true cross-platform portability with zero binary dependencies.
5.  **Keyed Integrity:** Implemented HMAC-based "sealing" of day hashes.
6.  **Security & Privacy:**
    - Replaced hardcoded passphrases with `getpass` prompts.
    - Encrypted habit `metadata` within the ledger.
7.  **CLI UX:** Refactored to `argparse` and added a `list` command for detailed, decrypted habit history.
8.  **Verification:** Created a comprehensive `unittest`-based test suite in `tests/run_tests.py`.

## Next Steps
- [ ] **Identity Export:** Create a command to export the derived keys or "identity" to allow ledger verification on other machines.
- [ ] **Flexible Date Ranges:** Extend the `rep` and `list` commands to support specific date ranges (e.g., `--from` and `--to`).
- [ ] **Ledger Pruning/Archiving:** Consider strategies for managing long-term ledger growth.
