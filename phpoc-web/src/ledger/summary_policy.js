/**
 * SummaryPolicy — year/month boundary summary block insertion policies.
 *
 * Pluggable policy hierarchy. The default YearMonthSummaryPolicy matches
 * the CLI's original behavior. Summary blocks are inserted between the
 * previous block and the upcoming day block when a date boundary is crossed.
 *
 * Usage:
 *   import { YearMonthSummaryPolicy } from './summary_policy.js';
 *   const policy = new YearMonthSummaryPolicy(crypto, masterKey, identitySecret);
 *   const blocks = policy.getSummaryBlocks(prevBlock, '2026-02-01');
 */

import { getBlockHash } from './utils.js';

// ── Helpers ────────────────────────────────────────────────────────────

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function formatMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Build a year_summary block with seal and optional identity signature.
 */
function makeYearSummary(crypto, masterKey, identitySecret, year, prevHash, dateStr) {
  const summary = {
    type: 'year_summary',
    year,
    prev_hash: prevHash,
    date: dateStr,
  };
  const json = JSON.stringify(summary, Object.keys(summary).sort());
  summary.year_hash = crypto.seal(json, masterKey);
  if (identitySecret) {
    summary.signature = crypto.sign(summary.year_hash, identitySecret);
  }
  return summary;
}

/**
 * Build a month_summary block with seal and optional identity signature.
 */
function makeMonthSummary(crypto, masterKey, identitySecret, month, prevHash, dateStr) {
  const summary = {
    type: 'month_summary',
    month,
    prev_hash: prevHash,
    date: dateStr,
  };
  const json = JSON.stringify(summary, Object.keys(summary).sort());
  summary.month_hash = crypto.seal(json, masterKey);
  if (identitySecret) {
    summary.signature = crypto.sign(summary.month_hash, identitySecret);
  }
  return summary;
}

// ── Abstract base ──────────────────────────────────────────────────────

class SummaryPolicy {
  /**
   * @param {object} crypto - CryptoService-like object with seal/sign methods.
   * @param {string} masterKey - Hex master key for sealing.
   * @param {string|null} [identitySecret=null] - Optional identity secret for signing.
   */
  constructor(crypto, masterKey, identitySecret = null) {
    this.crypto = crypto;
    this.masterKey = masterKey;
    this.identitySecret = identitySecret;
  }

  /**
   * Determine which summary blocks to insert between prevBlock and currDateStr.
   * @param {object} prevBlock - The last block currently in the ledger.
   * @param {string} currDateStr - ISO date string of the upcoming day block.
   * @returns {object[]} Array of summary block dicts (may be empty).
   */
  getSummaryBlocks(prevBlock, currDateStr) {
    throw new Error('getSummaryBlocks() not implemented');
  }
}

// ── YearMonthSummaryPolicy ─────────────────────────────────────────────

class YearMonthSummaryPolicy extends SummaryPolicy {
  /**
   * Default policy: inserts year_summary on year boundary and
   * month_summary on month boundary.
   *
   * Correctly handles cross-year month boundaries (e.g., Dec→Feb inserts
   * a month summary for Jan, not just the skipped month).
   */
  getSummaryBlocks(prevBlock, currDateStr) {
    const summaries = [];
    const currDate = parseDate(currDateStr);

    let prevHash = getBlockHash(prevBlock);

    // Resolve the effective previous year and month.
    // For a month_summary block, the 'month' field carries the actual
    // time period (e.g. "2025-12"), which may differ from the 'date' field.
    let prevYear, prevMon;
    if (prevBlock.type === 'month_summary' && prevBlock.month) {
      const parts = prevBlock.month.split('-');
      prevYear = parseInt(parts[0], 10);
      prevMon = parseInt(parts[1], 10);
    } else {
      const prevDate = parseDate(prevBlock.date || '1970-01-01');
      prevYear = prevDate.year;
      prevMon = prevDate.month;
    }

    const yearsDiff = currDate.year - prevYear;

    // Year boundary: insert year summary if year changed and prev
    // block is not already a year_summary
    if (currDate.year > prevYear && prevBlock.type !== 'year_summary') {
      const yearSummary = makeYearSummary(
        this.crypto, this.masterKey, this.identitySecret,
        prevYear, prevHash, currDateStr
      );
      summaries.push(yearSummary);
      prevHash = yearSummary.year_hash;
    }

    // Evaluate whether the effective month has actually changed.
    const monthChanged = (currDate.month !== prevMon || yearsDiff > 0);

    if (monthChanged) {
      // Compute the candidate month to summarize.
      let summarizeYear, summarizeMon;
      if (currDate.month === 1) {
        summarizeYear = currDate.year - 1;
        summarizeMon = 12;
      } else {
        summarizeYear = currDate.year;
        summarizeMon = currDate.month - 1;
      }

      const monthStr = formatMonth(summarizeYear, summarizeMon);

      // Don't insert a month summary if:
      //   a) The previous block is already a month_summary for this month, OR
      //   b) December summary when a year summary was just inserted
      const isSameMonth = (
        prevBlock.type === 'month_summary' &&
        prevBlock.month === monthStr
      );
      if (!isSameMonth) {
        const monthSummary = makeMonthSummary(
          this.crypto, this.masterKey, this.identitySecret,
          monthStr, prevHash, currDateStr
        );
        summaries.push(monthSummary);
      }
    }

    return summaries;
  }
}

// ── YearOnlySummaryPolicy ──────────────────────────────────────────────

class YearOnlySummaryPolicy extends SummaryPolicy {
  /** Only inserts year summaries, never month summaries. */
  getSummaryBlocks(prevBlock, currDateStr) {
    const summaries = [];
    const prevDate = parseDate(prevBlock.date || '1970-01-01');
    const currDate = parseDate(currDateStr);

    if (currDate.year > prevDate.year && prevBlock.type !== 'year_summary') {
      const prevHash = getBlockHash(prevBlock);
      const yearSummary = makeYearSummary(
        this.crypto, this.masterKey, this.identitySecret,
        prevDate.year, prevHash, currDateStr
      );
      summaries.push(yearSummary);
    }

    return summaries;
  }
}

// ── NoSummaryPolicy ────────────────────────────────────────────────────

class NoSummaryPolicy extends SummaryPolicy {
  /** Never inserts any summary blocks. */
  getSummaryBlocks(prevBlock, currDateStr) {
    return [];
  }
}

export {
  SummaryPolicy,
  YearMonthSummaryPolicy,
  YearOnlySummaryPolicy,
  NoSummaryPolicy,
};
