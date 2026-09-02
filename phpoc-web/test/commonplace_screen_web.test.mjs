/**
 * commonplace_screen_web.test.mjs — Commonplace screen surface test suite (Phase 2 RED).
 *
 * Groups L (6) + A (8) + T (5) from docs/planning/COMMONPLACE_BOOK_UI_WEB_PHASE1.md.
 * Vitest + @testing-library/react. `CommonplaceScreen` receives its `service` as
 * a **prop** (not a context/provider), so these tests render it against a mock
 * service with zero DevModeContext mocking.
 *
 * Phase 2 (RED): `src/components/screens/CommonplaceScreen.jsx`,
 * `AddEntrySheet.jsx`, and `TopicIndex.jsx` do not exist yet, so every test
 * fails on import.
 *
 * DOM contract (drives Phase 3):
 *   - CommonplaceScreen header: <h1>Commonplace</h1>, "{n} entries" count, and an
 *     "Add entry" button (aria-label "Add entry").
 *   - Verification badge: <span data-testid="commonplace-verify-badge"> with text
 *     "verified" (verify() → true) or "failed" (verify() → false).
 *   - Entry list: each <li data-testid="commonplace-entry"> with a title button,
 *     a passage <p data-testid="commonplace-entry-passage" data-expanded="true|false">,
 *     and tag chips rendered as "#tag".
 *   - Empty state: "Your Commonplace is empty" + an add prompt.
 *   - AddEntrySheet: heading "Add a Commonplace entry", inputs labelled Title /
 *     Passage / Tags / Ad-hoc note (optional), Save + Cancel. Blank title →
 *     "Please enter a title"; blank passage → "The passage cannot be empty".
 *   - TopicIndex: chips labelled "{tag} ({count})" (plus "untagged"), toggling
 *     the filter; selected chip toggles off when clicked again.
 *
 * Run: npx vitest run test/commonplace_screen_web.test.mjs
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

import CommonplaceScreen from '../src/components/screens/CommonplaceScreen.jsx';

// ── Mock service ─────────────────────────────────────────────────────

/** Mirror of CommonplaceService.buildTagIndex (decrypt-and-scan). */
function buildIndex(entries) {
  const idx = {};
  for (const e of entries) {
    const tags = (e.tags || []).map(String);
    if (tags.length === 0) {
      idx.untagged = (idx.untagged || 0) + 1;
      continue;
    }
    for (const tag of new Set(tags)) {
      idx[tag] = (idx[tag] || 0) + 1;
    }
  }
  return idx;
}

function makeMockService(initialEntries = [], { verify = true } = {}) {
  const entries = [...initialEntries];
  return {
    readEntries: vi.fn(async () => [...entries]),
    verify: vi.fn(() => verify),
    buildTagIndex: vi.fn(() => buildIndex(entries)),
    getEntryCount: vi.fn(() => entries.length),
    getLastHash: vi.fn(() => 'hash-tip'),
    ensureGenesis: vi.fn(async () => {}),
    addEntry: vi.fn(async ({ title, entry, tags, adHoc }) => {
      entries.push({
        title,
        entry,
        tags,
        ...(adHoc ? { ad_hoc: adHoc } : {}),
        timestamp_ms: Date.now(),
        date: '2024-01-01',
      });
    }),
    __entries: entries,
  };
}

function renderScreen(service) {
  return render(React.createElement(CommonplaceScreen, { service }));
}

// ═══════════════════════════════════════════════════════════════════
// Group L: list, empty state, verification badge (6)
// ═══════════════════════════════════════════════════════════════════

describe('L: Commonplace screen — list / empty / badge', () => {
  it('L1: lists each committed entry (title + passage preview)', async () => {
    renderScreen(makeMockService([
      { title: 'First note', entry: 'The first passage of the book.', tags: ['topic'] },
      { title: 'Second note', entry: 'A passage about philosophy.', tags: ['philosophy'] },
    ]));

    expect(await screen.findByText('First note')).toBeInTheDocument();
    expect(screen.getByText('Second note')).toBeInTheDocument();
    expect(screen.getByText('The first passage of the book.')).toBeInTheDocument();
    expect(screen.getByText('A passage about philosophy.')).toBeInTheDocument();
  });

  it('L2: each listed entry shows its tags as chips', async () => {
    renderScreen(makeMockService([
      { title: 'First note', entry: 'passage', tags: ['topic', 'philosophy'] },
    ]));

    await screen.findByText('First note');
    expect(screen.getByText('#topic')).toBeInTheDocument();
    expect(screen.getByText('#philosophy')).toBeInTheDocument();
  });

  it('L3: an empty book shows an empty-state message with an add prompt', async () => {
    renderScreen(makeMockService([]));

    expect(await screen.findByText('Your Commonplace is empty')).toBeInTheDocument();
    expect(screen.getByText(/add your first passage/i)).toBeInTheDocument();
  });

  it('L4: the screen header shows the entry count', async () => {
    renderScreen(makeMockService([
      { title: 'A', entry: 'p', tags: [] },
      { title: 'B', entry: 'p', tags: [] },
    ]));

    expect(await screen.findByText('2 entries')).toBeInTheDocument();
  });

  it('L5: the screen shows a verification status badge (verified / failed)', async () => {
    const ok = renderScreen(makeMockService([{ title: 'A', entry: 'p', tags: [] }], { verify: true }));
    await ok.findByText('A');
    expect(screen.getByTestId('commonplace-verify-badge')).toHaveTextContent('verified');

    ok.unmount();
    renderScreen(makeMockService([{ title: 'A', entry: 'p', tags: [] }], { verify: false }));
    await screen.findByText('A');
    expect(screen.getByTestId('commonplace-verify-badge')).toHaveTextContent('failed');
  });

  it('L6: clicking an entry expands to show the full passage', async () => {
    renderScreen(makeMockService([
      { title: 'First note', entry: 'A very long passage that gets truncated when collapsed.', tags: [] },
    ]));

    await screen.findByText('First note');
    const passage = screen.getByTestId('commonplace-entry-passage');
    expect(passage.getAttribute('data-expanded')).toBe('false');

    fireEvent.click(screen.getByText('First note'));
    expect(passage.getAttribute('data-expanded')).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group A: Add-entry flow (8)
// ═══════════════════════════════════════════════════════════════════

describe('A: Add-entry flow', () => {
  it('A1: Add-entry opens from a "+ / Add" affordance on the Commonplace screen', async () => {
    renderScreen(makeMockService([]));
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(screen.getByText('Add a Commonplace entry')).toBeInTheDocument();
  });

  it('A2: a blank title is rejected with an inline error (no commit)', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Passage' }), {
      target: { value: 'some passage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Please enter a title')).toBeInTheDocument();
    expect(service.addEntry).not.toHaveBeenCalled();
  });

  it('A3: a blank passage entry is rejected (no commit)', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'My Note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('The passage cannot be empty')).toBeInTheDocument();
    expect(service.addEntry).not.toHaveBeenCalled();
  });

  it('A4: entering title + passage + tags and saving calls service.addEntry', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'My Note' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Passage' }), {
      target: { value: 'some passage' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tags' }), {
      target: { value: 'Topic, Philosophy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(service.addEntry).toHaveBeenCalledTimes(1));
    const call = service.addEntry.mock.calls[0][0];
    expect(call.title).toBe('My Note');
    expect(call.entry).toBe('some passage');
    expect(call.tags).toEqual(['Topic', 'Philosophy']);
  });

  it('A5: after a successful add the list refreshes and shows the new entry', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'New Entry' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Passage' }), {
      target: { value: 'fresh passage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('New Entry')).toBeInTheDocument();
    expect(screen.getByText('fresh passage')).toBeInTheDocument();
  });

  it('A6: Cancel discards the draft without committing', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Draft' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Passage' }), {
      target: { value: 'draft passage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(service.addEntry).not.toHaveBeenCalled();
    expect(screen.queryByText('Add a Commonplace entry')).not.toBeInTheDocument();
  });

  it('A7: "Add" is add-not-in-place — there is no edit-entry affordance on a listed entry', async () => {
    renderScreen(makeMockService([
      { title: 'First note', entry: 'passage', tags: [] },
    ]));

    await screen.findByText('First note');
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('A8: optional ad-hoc k/v is capturable in the add form and persisted', async () => {
    const service = makeMockService([]);
    renderScreen(service);
    await screen.findByText('Your Commonplace is empty');

    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Annotated' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Passage' }), {
      target: { value: 'passage' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Ad-hoc note (optional)' }), {
      target: { value: 'born 1844' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(service.addEntry).toHaveBeenCalledTimes(1));
    expect(service.addEntry.mock.calls[0][0].adHoc).toEqual({ note: 'born 1844' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group T: Topic / tag index (5)
// ═══════════════════════════════════════════════════════════════════

describe('T: Topic / tag index', () => {
  it('T1: the topic index lists all distinct tags with entry counts', async () => {
    renderScreen(makeMockService([
      { title: 'A', entry: 'p', tags: ['topic'] },
      { title: 'B', entry: 'p', tags: ['philosophy'] },
    ]));

    await screen.findByText('A');
    expect(screen.getByText('topic (1)')).toBeInTheDocument();
    expect(screen.getByText('philosophy (1)')).toBeInTheDocument();
  });

  it('T2: selecting a topic filters the entry list to matching tags', async () => {
    renderScreen(makeMockService([
      { title: 'A', entry: 'p', tags: ['topic'] },
      { title: 'B', entry: 'p', tags: ['philosophy'] },
    ]));

    await screen.findByText('A');
    fireEvent.click(screen.getByText('topic (1)'));

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByText('B')).not.toBeInTheDocument();
  });

  it('T3: clearing the topic selection restores the full list', async () => {
    renderScreen(makeMockService([
      { title: 'A', entry: 'p', tags: ['topic'] },
      { title: 'B', entry: 'p', tags: ['philosophy'] },
    ]));

    await screen.findByText('A');
    fireEvent.click(screen.getByText('topic (1)'));
    fireEvent.click(screen.getByText('topic (1)')); // toggle off

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('T4: an entry with multiple tags appears under each of its topics', async () => {
    renderScreen(makeMockService([
      { title: 'Multi', entry: 'p', tags: ['topic', 'philosophy'] },
      { title: 'Single', entry: 'p', tags: ['topic'] },
    ]));

    await screen.findByText('Multi');
    fireEvent.click(screen.getByText('philosophy (1)'));
    expect(screen.getByText('Multi')).toBeInTheDocument();
    expect(screen.queryByText('Single')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('philosophy (1)')); // clear
    fireEvent.click(screen.getByText('topic (2)'));
    expect(screen.getByText('Multi')).toBeInTheDocument();
    expect(screen.getByText('Single')).toBeInTheDocument();
  });

  it('T5: the topic index labels an entry with no tags as an "untagged" bucket', async () => {
    renderScreen(makeMockService([
      { title: 'Tagged', entry: 'p', tags: ['topic'] },
      { title: 'Untagged', entry: 'p', tags: [] },
    ]));

    await screen.findByText('Tagged');
    expect(screen.getByText('untagged (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('untagged (1)'));
    expect(screen.queryByText('Tagged')).not.toBeInTheDocument();
    expect(screen.getByText('Untagged')).toBeInTheDocument();
  });
});
