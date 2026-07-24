# Calendar View — Test Exploration (Phase 1)

> **Reference:** `phpoc-web` History screen (collapsible calendar grid with green dots)
> **Purpose:** Blueprint of all needed test assertions for calendar grid + date filtering.
> **Status:** ✅ Phase 1 (test exploration)
> **Next Phase:** ✅ Phase 2 complete → Phase 3 (GREEN: implementation)

## Investigation Summary

### Web Reference (phpoc-web `src/components/screens/History.jsx`)

The web History screen implements two features missing from Flutter:

1. **Calendar month grid** — month-year navigation, day-of-week headers, day cells with green
   dot indicators for dates that have entries. Clicking a day filters entries to that date.

2. **Single-date filter** — `filterDate` state (YYYY-MM-DD string) drives entry filtering.
   Tapping a day sets `filterDate`, tapping again clears it. Entries are filtered by
   `e.date === filterDate` (strict equality on the date string).

Web key data flow:
```
entries = sync.getCompleted()
  → normalized { ...e, date: new Date(e.start_epoch).toISOString().slice(0,10) }
  → datesWithEntries = new Set(entries.map(e => e.date))
  → calendarDays grid with hasEntries: datesWithEntries.has(dateStr)
  → filtered = entries.filter(e => e.date === filterDate)
  → grouped by date → rendered with date headers
```

### Flutter Gaps

| Feature | Web | Flutter | Status |
|---------|-----|---------|--------|
| Calendar month grid | ✅ Collapsible with green dots | ❌ Not implemented | Missing |
| Green dot indicators | ✅ 4px circle, `var(--accent-green)` | ❌ Not implemented | Missing |
| Single-date filter (tap day) | ✅ Sets/Clears `filterDate` | ❌ Not implemented | Missing |
| Date range filter | ❌ Not in web | ✅ `showDateRangePicker` in Flutter | May be broken |
| Date-grouped entries | ✅ Grouped by date headers | ❌ Flat list | Missing |
| `getCompleted()` | ✅ Dedicated method | ❌ Uses `getEntries()` + filter | Missing helper |
| Entry `date` field | ✅ Normalized from `start_epoch` | ❌ No date field | Missing normalization |

### Root Cause Analysis

**Filter by date/range "does not work at all":**

The Flutter `HistoryScreen._pickDateRange()` function uses `showDateRangePicker()` from
Material. This should technically work — it returns a `DateTimeRange` with `start` and
`end`, which feeds into `sync.getEntries(from:, to:)`. However:

1. The `SyncService.getEntries()` compares `startDt.isBefore(from)` — where `from` is
   midnight of the selected date. If an entry starts on the selected date (e.g., 3 PM),
   its DateTime is AFTER midnight, so `isBefore(from)` is FALSE, and the entry passes.
   This means the filter should work for the start date itself.

2. BUT for the END date: `isAfter(to)` compares against midnight. If the "to" date is
   July 20, midnight, then an entry from July 20 at 3 PM passes because `3 PM.isAfter(midnight)` 
   is true → entry is filtered OUT. This is a bug — the range end should be inclusive.

3. The date range picker itself may fail on some platforms (Material vs Cupertino).

4. There is no single-date filter — the calendar grid approach from web doesn't exist.

### Approach

Follow phpoc-web's simpler single-date filter pattern:

1. Add a calendar month grid widget with green dots
2. Single-date tap to filter (web's approach)
3. Keep date range as secondary option
4. Add `getCompleted()` to `SyncService` for consistency
5. Add date normalization to entries

## Architecture Overview

```
HistoryScreen
  ├── CalendarMonthGrid (new widget)
  │     ├── Month/Year navigation
  │     ├── Day-of-week headers
  │     └── Day cells with green dots
  ├── Date filter chip (single date or range)
  ├── Date range picker button (secondary)
  └── Grouped entry list (by date, with headers)
```

Data flow:
```
SyncService.getCompleted()
  → normalize: add 'date' = YYYY-MM-DD from start_epoch
  → compute: Set<String> datesWithEntries
  → CalendarMonthGrid: green dots on dates in set
  → tap day → set filterDate (YYYY-MM-DD)
  → filter entries where date matches
  → group by date → render with date headers
```

## Test Groups

### Group K: FormatUtils — Date helpers — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `epochToDateStr(0)` returns `"1970-01-01"` | Zero-epoch guard | Sentinel for missing/invalid timestamps |
| K2 | `epochToDateStr(1780267505257)` returns `"2026-06-01"` | Base conversion | Correct YYYY-MM-DD from ms epoch |
| K3 | `epochToDateStr(null)` returns `"unknown"` | Null safety | Graceful handling of missing epoch |
| K4 | Multiple epochs on same date produce same string | Idempotency | Group-by works on shared date key |

### Group L: SyncService — getCompleted() — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | `getCompleted()` returns only entries with `is_active==false` | Completion filter | Matches web semantics |
| L2 | Each entry has a `date` field (YYYY-MM-DD from start_epoch) | Date normalization | Calendar needs date strings |
| L3 | Entries with `start_epoch==0` get `date="unknown"` | Degraded-data guard | Survives bad data |
| L4 | `getCompleted()` returns entries sorted by start_epoch descending | Sort order | Most recent first |
| L5 | `getCompleted()` returns empty list when staging is empty | Empty state | No crash on first launch |

### Group M: CalendarMonthGrid widget — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | Widget renders month name and year header | Header display | Users can identify current view |
| M2 | Day-of-week headers (S M T W T F S) displayed | Column labels | Standard calendar UX |
| M3 | Correct number of days for given month/year | Calendar math | Months have 28-31 days |
| M4 | Leading/trailing empty cells for partial weeks | Grid layout | Months don't always start on Sunday |
| M5 | Green dot rendered on dates present in `datesWithEntries` | Entry indicator | User sees which dates have activity |
| M6 | No green dot on dates absent from `datesWithEntries` | Clean display | Only real data gets indicators |
| M7 | Tapping a day calls `onDateSelected(dateStr)` with YYYY-MM-DD | Selection callback | Drives filter in parent |
| M8 | Previously selected date visually distinguished | Selection state | User knows current filter |
| M9 | Month navigation (prev/next) updates displayed month | Navigation | User can browse history |
| M10 | Year navigation buttons update displayed year | Year navigation | Faster than month-by-month |

### Group N: HistoryScreen — Calendar integration — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| N1 | HistoryScreen renders CalendarMonthGrid when entries exist | Widget integration | Calendar visible when data present |
| N2 | Calendar grid shows green dots on dates from loaded entries | Indicator integration | End-to-end: entries → dots |
| N3 | Tapping a calendar day filters entry list to that date only | Filter behavior | Core single-date filter |
| N4 | Tapping selected day clears filter and shows all entries | Clear filter | Toggle behavior matches web |
| N5 | Filter chip shows selected date (e.g., "Jun 1, 2026") | UX feedback | User knows active filter |
| N6 | "Clear filter" button removes date filter | Filter reset | Explicit clear action |
| N7 | Date range picker opens and applies range filter | Range filter | Secondary filter mode |
| N8 | Range filter chip shows "Jun 1 – Jun 3, 2026" when range active | Range UX | Clear what's filtered |

### Group O: HistoryScreen — Date grouping — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| O1 | Entries grouped by date with date headers (e.g., "Today", "Yesterday", "Jun 1") | Grouped display | Matches web pattern |
| O2 | "Today" label shown for current date entries | Relative labels | Familiar UX |
| O3 | Multiple entries on same date listed under one header | Grouping | Compact, organized |
| O4 | Groups sorted by date descending (most recent first) | Sort order | Chronological browsing |

### Group P: Date range filter fix — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| P1 | `getEntries(to: date)` includes entries ON the end date | Inclusive range | End date should include all entries that day |
| P2 | `getEntries(from: date)` includes entries ON the start date | Inclusive range | Start date should include all entries that day |
| P3 | Range filter uses end-of-day for `to` boundary | Midnight fix | Entries at 11 PM should pass date match |

---

**Totals:** 34 assertions across 6 groups (K–P)
