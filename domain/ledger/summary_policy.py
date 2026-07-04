"""SummaryPolicy: year/month boundary summary block insertion.

Extracts the summary insertion logic from core/ledger.py sync_day() into
a pluggable policy hierarchy. The default YearMonthSummaryPolicy matches
the original behavior exactly.
"""

from domain.ledger.helpers import get_block_hash

import json
import time
from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any

from security.crypto import AbstractCryptoManager


class SummaryPolicy(ABC):
    """Abstract base for summary block policies.

    Subclasses implement get_summary_blocks() which returns a list of
    summary block dicts (year_summary, month_summary) to insert between
    the previous block and the upcoming day block.
    """

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        identity_secret: Optional[bytes] = None,
    ):
        self.crypto = crypto
        self.identity_secret = identity_secret

    @abstractmethod
    def get_summary_blocks(
        self, prev_block: dict, curr_date_str: str
    ) -> List[Dict[str, Any]]:
        """Determine which summary blocks to insert between prev_block and curr_date_str.

        Args:
            prev_block: The last block currently in the ledger (any type).
            curr_date_str: ISO date string of the upcoming day block.

        Returns:
            List of summary block dicts to insert (may be empty).
        """
        ...

    def _make_year_summary(
        self, year: int, prev_hash: str, date_str: str
    ) -> Dict[str, Any]:
        """Build a year_summary block with seal and optional identity signature."""
        summary = {
            "type": "year_summary",
            "year": year,
            "prev_hash": prev_hash,
            "date": date_str,
        }
        summary["year_hash"] = self.crypto.seal(
            json.dumps(summary, sort_keys=True)
        )
        if self.identity_secret:
            summary["signature"] = self.crypto.sign(
                summary["year_hash"], self.identity_secret
            )
        return summary

    def _make_month_summary(
        self, month: str, prev_hash: str, date_str: str
    ) -> Dict[str, Any]:
        """Build a month_summary block with seal and optional identity signature."""
        summary = {
            "type": "month_summary",
            "month": month,
            "prev_hash": prev_hash,
            "date": date_str,
        }
        summary["month_hash"] = self.crypto.seal(
            json.dumps(summary, sort_keys=True)
        )
        if self.identity_secret:
            summary["signature"] = self.crypto.sign(
                summary["month_hash"], self.identity_secret
            )
        return summary

    @staticmethod
    def _parse_date(date_str: str) -> time.struct_time:
        """Parse an ISO date string into a time.struct_time."""
        return time.strptime(date_str, "%Y-%m-%d")

    @staticmethod
    def _format_month(year: int, month: int) -> str:
        """Format a (year, month) pair as 'YYYY-MM'."""
        return f"{year}-{month:02d}"


class YearMonthSummaryPolicy(SummaryPolicy):
    """Default policy: inserts year_summary on year boundary and
    month_summary on month boundary.

    Correctly handles cross-year month boundaries (e.g., Dec→Feb inserts
    a month summary for Jan, not just Dec's month).
    """

    def get_summary_blocks(
        self, prev_block: dict, curr_date_str: str
    ) -> List[Dict[str, Any]]:
        summaries: List[Dict[str, Any]] = []
        curr_date = self._parse_date(curr_date_str)

        prev_hash = get_block_hash(prev_block)

        # Resolve the effective previous year and month.
        # For a month_summary block, the 'month' field carries the actual
        # time period (e.g. "2025-12"), which may differ from the 'date'
        # field (which is set to the upcoming day's date for prev_hash
        # continuity).
        if prev_block.get("type") == "month_summary" and "month" in prev_block:
            month_parts = prev_block["month"].split("-")
            prev_year = int(month_parts[0])
            prev_mon = int(month_parts[1])
        else:
            prev_date = self._parse_date(prev_block.get("date", "1970-01-01"))
            prev_year = prev_date.tm_year
            prev_mon = prev_date.tm_mon

        years_diff = curr_date.tm_year - prev_year

        # Year boundary: insert year summary if year changed and prev
        # block is not already a year_summary
        if (
            curr_date.tm_year > prev_year
            and prev_block.get("type") != "year_summary"
        ):
            year_summary = self._make_year_summary(
                prev_year, prev_hash, curr_date_str
            )
            summaries.append(year_summary)
            # Update prev_hash for subsequent summaries
            prev_hash = year_summary["year_hash"]

        # Evaluate whether the effective month has actually changed.
        # Month changed if:
        #   - Different month within the same year, OR
        #   - Years are different (month necessarily changed)
        month_changed = (
            curr_date.tm_mon != prev_mon or years_diff > 0
        )

        if month_changed:
            # Compute the candidate month to summarize.
            # This is the month just before the current date, accounting for
            # year wrap (Jan → previous December).
            if curr_date.tm_mon == 1:
                summarize_year = curr_date.tm_year - 1
                summarize_mon = 12
            else:
                summarize_year = curr_date.tm_year
                summarize_mon = curr_date.tm_mon - 1

            month_str = self._format_month(summarize_year, summarize_mon)

            # Don't insert a month summary if:
            #   a) The previous block is already a month_summary for this month, OR
            #   b) This would be December summary when a year summary was just
            #      inserted (year summary already covers December)
            is_same_month = (
                prev_block.get("type") == "month_summary"
                and prev_block.get("month") == month_str
            )
            dec_with_year = (
                summarize_mon == 12
                and years_diff > 0
                and any(s.get("type") == "year_summary" for s in summaries)
            )

            if not is_same_month and not dec_with_year:
                month_summary = self._make_month_summary(
                    month_str,
                    prev_hash,
                    curr_date_str,
                )
                summaries.append(month_summary)

        return summaries


class YearOnlySummaryPolicy(SummaryPolicy):
    """Policy that only inserts year summaries, never month summaries."""

    def get_summary_blocks(
        self, prev_block: dict, curr_date_str: str
    ) -> List[Dict[str, Any]]:
        summaries: List[Dict[str, Any]] = []
        prev_date = self._parse_date(prev_block.get("date", "1970-01-01"))
        curr_date = self._parse_date(curr_date_str)

        if (
            curr_date.tm_year > prev_date.tm_year
            and prev_block.get("type") != "year_summary"
        ):
            prev_hash = get_block_hash(prev_block)
            year_summary = self._make_year_summary(
                prev_date.tm_year, prev_hash, curr_date_str
            )
            summaries.append(year_summary)

        return summaries


class NoSummaryPolicy(SummaryPolicy):
    """Policy that never inserts any summary blocks."""

    def get_summary_blocks(
        self, prev_block: dict, curr_date_str: str
    ) -> List[Dict[str, Any]]:
        return []
