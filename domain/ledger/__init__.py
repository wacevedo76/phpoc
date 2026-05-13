"""Phase 3: Ledger Engine.

Extracts chain logic from core/ledger.py into four clean modules:
  - chain.py: LedgerChain (block sealing, signing, append, truncate, verify)
  - index_manager.py: IndexManager (duration index by date/title)
  - summary_policy.py: SummaryPolicy hierarchy (year/month summary insertion)
  - engine.py: LedgerEngine (commit, verify, revert — unified public API)

Critical constraint (🔴 O8): Block format must be byte-identical to
current core/ledger.py output.
"""
