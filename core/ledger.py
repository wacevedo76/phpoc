"""Thin re-export shim — v0.3.0 backward compatibility for LedgerDomain.

All legacy code has been moved to compat/v0_3_0.py. This module exists
solely so that existing test imports (from core.ledger import LedgerDomain)
continue to work without changes.

New code should import from compat.v0_3_0 directly if absolutely needed,
or better yet, use StagingService + LedgerEngine directly.
"""

from compat.v0_3_0 import LedgerDomain, _LegacyChainAdapter  # noqa: F401
