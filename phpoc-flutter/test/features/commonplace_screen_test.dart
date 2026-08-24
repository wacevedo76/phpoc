import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_service.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/features/commonplace/add_entry_bottom_sheet.dart';
import 'package:phpoc_flutter/features/commonplace/commonplace_screen.dart';
import 'package:phpoc_flutter/features/commonplace/topic_index.dart';

/// Phase 2 (RED) — Commonplace screen + add-entry + topic index.
///
/// Implements Groups L (6) + A (8) + T (5) from
/// docs/planning/flutter/COMMONPLACE_BOOK_UI_PHASE1.md.
///
/// Expected: these tests FAIL (RED) because the Commonplace screen surface
/// (`commonplace_screen.dart`), add-entry sheet (`add_entry_bottom_sheet.dart`),
/// and topic index (`topic_index.dart`) plus their service provider wiring are
/// not implemented yet (Phase 3).

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

class _FakeCommonplaceStore {
  final List<Map<String, dynamic>> _blocks = [];
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e);
  }
  void appendBlocks(List<Map<String, dynamic>> blocks) =>
      _blocks.addAll(blocks);
  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }
  int getBlockCount() => _blocks.length;
  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;
}

/// Provides a real [CommonplaceService] over the given [service] (or a fresh
/// one), wired into [data_providers.commonplaceServiceProvider] so the screen
/// reads an actual sealed chain.
List<Override> _commonplaceOverrides(CommonplaceService service) {
  return [
    data_providers.commonplaceServiceProvider.overrideWith((ref) => service),
  ];
}

/// Seed the given service with [entries] so the screen has content.
Future<void> _seedEntries(
  CommonplaceService service,
  List<({String title, String entry, List<String> tags})> entries,
) async {
  await service.ensureGenesis(
    username: 'u',
    email: 'e@example.com',
    recoverySeedEnc: 's',
    identityPubKey: 'p',
    identitySecretEncFallback: 'f',
  );
  for (final e in entries) {
    await service.addEntry(title: e.title, entry: e.entry, tags: e.tags);
  }
}

/// Fresh in-memory, same-MK [CommonplaceService] for widget tests.
CommonplaceService _makeService() {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  return CommonplaceService(
    crypto: crypto,
    store: _FakeCommonplaceStore(),
  );
}

/// Pump [CommonplaceScreen] wired to the given [service].
Future<void> _pumpScreen(
  WidgetTester tester, {
  CommonplaceService? service,
}) async {
  final svc = service ?? _makeService();
  await tester.pumpWidget(
    ProviderScope(
      overrides: _commonplaceOverrides(svc),
      child: const MaterialApp(home: CommonplaceScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group L: Commonplace screen — list, empty state, verification badge
  // ═══════════════════════════════════════════════════════════════

  group('L: Commonplace screen — list, empty state, badge', () {
    testWidgets('CPUI-L1: the screen lists each entry title + passage preview',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Poem', entry: 'To a Skylark', tags: ['poetry']),
        (title: 'Prayer', entry: 'Evening psalm', tags: ['meditation']),
      ]);
      await _pumpScreen(tester, service: svc);

      expect(find.text('Poem'), findsOneWidget);
      expect(find.text('Prayer'), findsOneWidget);
    });

    testWidgets('CPUI-L2: each listed entry shows its tags as chips',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'A', entry: 'x', tags: ['poetry', 'allegory']),
      ]);
      await _pumpScreen(tester, service: svc);

      expect(find.text('poetry'), findsOneWidget);
      expect(find.text('allegory'), findsOneWidget);
    });

    testWidgets('CPUI-L3: an empty book shows an empty-state with an add prompt',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, []);
      await _pumpScreen(tester, service: svc);

      // Empty-state message + add prompt text.
      expect(find.textContaining('empty', findRichText: true), findsWidgets);
    });

    testWidgets('CPUI-L4: the screen header shows the entry count',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'A', entry: 'a', tags: []),
        (title: 'B', entry: 'b', tags: []),
        (title: 'C', entry: 'c', tags: []),
      ]);
      await _pumpScreen(tester, service: svc);

      expect(find.textContaining('3'), findsWidgets);
    });

    testWidgets('CPUI-L5: the screen shows a verification status badge',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'A', entry: 'a', tags: []),
      ]);
      await _pumpScreen(tester, service: svc);

      // Verified badge text present (or a positive verification cue).
      expect(find.textContaining('verified', findRichText: true),
          findsWidgets);
    });

    testWidgets('CPUI-L6: tapping an entry expands to show the full passage',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      const longPassage =
          'A very long passage that would otherwise be truncated away; it '
          'continues far beyond what a single-line title preview would show.';
      await _seedEntries(svc, [
        (title: 'Long', entry: longPassage, tags: ['prose']),
      ]);
      await _pumpScreen(tester, service: svc);

      // Initially the full passage may be collapsed; tapping expands it.
      await tester.tap(find.text('Long'));
      await tester.pumpAndSettle();

      expect(find.textContaining('would otherwise be truncated'), findsWidgets);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group A: Add-entry flow
  // ═══════════════════════════════════════════════════════════════

  group('A: Add-entry flow', () {
    testWidgets('CPUI-A1: add-entry opens from a "+/Add" affordance',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();
      expect(find.byType(AddEntryBottomSheet), findsOneWidget);
    });

    testWidgets('CPUI-A2: a blank title is rejected with an inline error',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byType(TextFormField).first, ''); // blank title
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.textContaining('title'), findsWidgets);
    });

    testWidgets('CPUI-A3: a blank passage entry is rejected (no commit)',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byType(TextFormField).at(0), 'Title only');
      // Leave the passage field blank.
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.textContaining('passage'), findsWidgets);
    });

    testWidgets('CPUI-A4: title + passage + tags on save calls service.addEntry',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).at(0), 'Inspiration');
      await tester.enterText(
          find.byType(TextFormField).at(1), 'the inspiring passage');
      await tester.enterText(find.byType(TextFormField).at(2), 'poetry');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      // The new entry appears in the list after the add refreshes.
      expect(find.text('Inspiration'), findsOneWidget);
    });

    testWidgets('CPUI-A5: after a successful add the list refreshes',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).at(0), 'Fresh');
      await tester.enterText(find.byType(TextFormField).at(1), 'new text');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.text('Fresh'), findsOneWidget);
    });

    testWidgets('CPUI-A6: cancel discards the draft without committing',
        (tester) async {
      await _pumpScreen(tester);
      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).at(0), 'Draft');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Draft never sealed: no 'Draft' entry rendered.
      expect(find.text('Draft'), findsNothing);
    });

    testWidgets('CPUI-A7: add is add-not-in-place — no edit affordance',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Standalone', entry: 'content', tags: ['t']),
      ]);
      await _pumpScreen(tester, service: svc);

      // There is an add affordance (discoverability) but NO edit affordance.
      expect(find.byTooltip('Add entry'), findsOneWidget);
      expect(find.byTooltip('Edit entry'), findsNothing);
    });

    testWidgets('CPUI-A8: optional ad-hoc k/v is capturable and persisted',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, []);
      await _pumpScreen(tester, service: svc);

      await tester.tap(find.byTooltip('Add entry'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).at(0), 'AdHoc');
      await tester.enterText(find.byType(TextFormField).at(1), 'x');
      // Ad-hoc k/v capture (e.g. a 'source' field in the form).
      await tester.enterText(find.byType(TextFormField).at(2), 'book-12');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      final entries = await svc.readEntries();
      expect(entries.single['title'], 'AdHoc');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group T: Topic / tag index
  // ═══════════════════════════════════════════════════════════════

  group('T: Topic / tag index', () {
    testWidgets('CPUI-T1: the topic index lists distinct tags with counts',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'A', entry: 'a', tags: ['poetry']),
        (title: 'B', entry: 'b', tags: ['poetry', 'meditation']),
      ]);
      await _pumpScreen(tester, service: svc);

      expect(find.byType(TopicIndex), findsOneWidget);
      expect(find.text('poetry'), findsOneWidget);
      expect(find.text('meditation'), findsOneWidget);
    });

    testWidgets('CPUI-T2: selecting a topic filters the list to matching tags',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Poem', entry: 'a', tags: ['poetry']),
        (title: 'Prayer', entry: 'b', tags: ['meditation']),
      ]);
      await _pumpScreen(tester, service: svc);

      await tester.tap(find.text('poetry'));
      await tester.pumpAndSettle();

      expect(find.text('Poem'), findsOneWidget);
      expect(find.text('Prayer'), findsNothing);
    });

    testWidgets('CPUI-T3: clearing the topic selection restores the full list',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Poem', entry: 'a', tags: ['poetry']),
        (title: 'Prayer', entry: 'b', tags: ['meditation']),
      ]);
      await _pumpScreen(tester, service: svc);

      await tester.tap(find.text('poetry'));
      await tester.pumpAndSettle();
      expect(find.text('Prayer'), findsNothing);

      // Clear / deselect the topic (e.g. tap the active chip again or a clear).
      await tester.tap(find.text('poetry').first);
      await tester.pumpAndSettle();

      expect(find.text('Poem'), findsOneWidget);
      expect(find.text('Prayer'), findsOneWidget);
    });

    testWidgets('CPUI-T4: an entry with multiple tags appears under each topic',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Bifurcated', entry: 'x', tags: ['poetry', 'meditation']),
      ]);
      await _pumpScreen(tester, service: svc);

      // Under the poetry topic filter and under the meditation topic filter.
      await tester.tap(find.text('poetry'));
      await tester.pumpAndSettle();
      expect(find.text('Bifurcated'), findsOneWidget);

      await tester.tap(find.text('poetry').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('meditation'));
      await tester.pumpAndSettle();
      expect(find.text('Bifurcated'), findsOneWidget);
    });

    testWidgets('CPUI-T5: the topic index labels no-tag entries as untagged',
        (tester) async {
      final svc = CommonplaceService(
        crypto: CryptoService()..initialize()..setMasterKey(mkHex),
        store: _FakeCommonplaceStore(),
      );
      await _seedEntries(svc, [
        (title: 'Untagged One', entry: 'a', tags: []),
      ]);
      await _pumpScreen(tester, service: svc);

      expect(find.textContaining('untagged', findRichText: true),
          findsWidgets);
    });
  });
}
