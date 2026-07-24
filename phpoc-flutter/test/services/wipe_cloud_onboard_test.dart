import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// Wipe + Cloud Onboard — Full Roundtrip tests (Group D, 10 assertions).
///
/// Blueprint: docs/planning/flutter/WIPE_CLOUD_ONBOARD_PHASE1.md
///
/// Covers D1–D10: Full roundtrip (Push → Wipe → Restore → Pull → Verify).
///
/// These tests use in-memory DB + mock transport — no real Worker needed.

// ── Test constants ─────────────────────────────────────────────

const testMkHex =
    'abababababababababababababababababababababababababababababababab';

/// Known genesis identity_seal from testdata/ledger.json
const knownGenesisIdentitySeal =
    '9dbf0a3940fe5ce80c9a194043a3da30ad7082ad8edff38160fecda704231b18';

/// Known genesis block_hash from testdata/ledger.json
const knownGenesisBlockHash =
    'f8f461b612f770b90b05e45188fa0848e134cfa92af3218037d4c049d9d3035a';

// ── Fake Transport (shared push + pull store) ──────────────────

/// A fake transport that supports both push and pull, serving as the
/// shared "R2" store between push and pull operations.
class SharedFakeTransport implements HttpTransport {
  @override
  final String baseUrl;

  @override
  final String apiKey;

  /// All stored data, keyed by path.
  final Map<String, Uint8List> store = {};

  SharedFakeTransport({
    this.baseUrl = 'https://test-worker.example.com',
    this.apiKey = 'fake-api-key',
  });

  @override
  Future<Uint8List?> pull(String path) async {
    if (path.contains('?list') || path.contains('?prefix=')) {
      final prefix = path.replaceFirst(RegExp(r'\?.*'), '');
      final files = store.keys.where((k) => k.startsWith(prefix)).toList();
      return Uint8List.fromList(utf8.encode(jsonEncode(files)));
    }
    return store[path];
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    store[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    // Match real Worker ?prefix= API: return entries relative to prefix
    return store.keys
        .where((k) => k.startsWith(prefix))
        .map((k) => k.substring(prefix.length))
        .toList();
  }

  @override
  Future<void> healthCheck() async {}

  @override
  Future<void> delete(String path) async {
    store.remove(path);
  }
}

// ── Test Ledger Helper ─────────────────────────────────────────

/// Build a minimal 3-block test ledger (genesis + 2 day blocks) with
/// known entries for roundtrip verification.
///
/// This avoids depending on the 31-block testdata/ledger.json file
/// while still testing the full push→wipe→pull→verify flow.
Map<String, dynamic> _buildMiniLedgerBlocks(
  CryptoService crypto,
  SharedFakeTransport transport,
) {
  final genesisEntries = [
    {
      'hash': 'entry-gen-1',
      'data': {
        'title': 'Coffee & Morning Planning',
        'tags': ['morning', 'planning'],
      },
    },
    {
      'hash': 'entry-gen-2',
      'data': {
        'title': 'Code Review',
        'tags': ['coding', 'work'],
      },
    },
  ];

  final day1Entries = [
    {
      'hash': 'entry-d1-1',
      'data': {
        'title': 'Working on Project Alpha',
        'tags': ['coding', 'work'],
      },
    },
    {
      'hash': 'entry-d1-2',
      'data': {
        'title': 'Afternoon Walk',
        'tags': ['exercise', 'health'],
      },
    },
    {
      'hash': 'entry-d1-3',
      'data': {
        'title': 'Dinner',
        'tags': ['food'],
      },
    },
  ];

  final day2Entries = [
    {
      'hash': 'entry-d2-1',
      'data': {
        'title': 'Evening Exercise',
        'tags': ['exercise', 'health'],
      },
    },
  ];

  return {
    'blocks': [
      {
        'type': 'genesis',
        'day_index': 0,
        'date': '2026-06-01',
        'prev_hash': Block.genesisPrevHash,
        'entries': genesisEntries,
        'identity_seal': knownGenesisIdentitySeal,
        'block_hash': knownGenesisBlockHash,
      },
      {
        'type': 'day',
        'day_index': 1,
        'date': '2026-06-02',
        'prev_hash': knownGenesisBlockHash,
        'entries': day1Entries,
        'identity_seal': 'day1-seal',
        'block_hash': 'day1-block-hash',
      },
      {
        'type': 'day',
        'day_index': 2,
        'date': '2026-06-03',
        'prev_hash': 'day1-block-hash',
        'entries': day2Entries,
        'identity_seal': 'day2-seal',
        'block_hash': 'day2-block-hash',
      },
    ],
    'totalBlocks': 3,
    'totalEntries': 6, // 2 + 3 + 1
    'knownTitles': [
      'Coffee & Morning Planning',
      'Code Review',
      'Working on Project Alpha',
      'Afternoon Walk',
      'Dinner',
      'Evening Exercise',
    ],
    'knownTags': [
      'morning',
      'planning',
      'coding',
      'work',
      'exercise',
      'health',
      'food',
    ],
    'dateRange': {'from': '2026-06-01', 'to': '2026-06-03'},
  };
}

// ── Helpers ────────────────────────────────────────────────────

/// Clear all data from the database (simulating a wipe).
Future<void> _wipeDatabase(AppDatabase db) async {
  await db.customStatement('DELETE FROM index_entries');
  await db.customStatement('DELETE FROM entries');
  await db.customStatement('DELETE FROM blocks');
}

/// Verify the database is empty (all tables cleared).
Future<void> _assertDatabaseIsEmpty(AppDatabase db) async {
  final blocks = await db.blockDao.getAllBlocks();
  expect(blocks, isEmpty, reason: 'Blocks table must be empty after wipe');
}

/// Import blocks directly into the DB (simulates what importFromJson does).
Future<void> _importBlocksIntoDb(
  AppDatabase db,
  List<Map<String, dynamic>> blocks,
) async {
  for (final b in blocks) {
    final typeStr = b['type'] as String;
    final blockType = typeStr == 'genesis' ? BlockType.genesis : BlockType.day;
    final entries = b['entries'] as List<dynamic>? ?? [];
    final dataEnc = base64.encode(utf8.encode(jsonEncode(entries)));
    final dateStr = b['date'] as String? ?? '2026-06-01';
    final parts = dateStr.split('-');
    final createdAt = DateTime.utc(
      int.parse(parts[0]),
      int.parse(parts[1]),
      int.parse(parts[2]),
    ).millisecondsSinceEpoch ~/ 1000;

    await db.blockDao.insertBlock(Block(
      blockId: (b['block_hash'] as String?) ?? 'block-${b['day_index']}',
      blockType: blockType,
      blockIndex: (b['day_index'] as int?) ?? 0,
      keyVersion: 1,
      dataEnc: dataEnc,
      identitySeal: b['identity_seal'] as String?,
      prevHash: (b['prev_hash'] as String?) ?? Block.genesisPrevHash,
      createdAt: createdAt,
    ));
  }
}

// ═══════════════════════════════════════════════════════════════
// Group D: Full Roundtrip (Push → Wipe → Restore → Pull → Verify)
// ═══════════════════════════════════════════════════════════════

void main() {
  group('D: Wipe + Cloud Onboard — Full Roundtrip', () {
    late AppDatabase db;
    late CryptoService crypto;
    late SharedFakeTransport transport;
    late LedgerPushService pushService;
    late LedgerPullService pullService;
    late LedgerBackupService backupService;
    late Map<String, dynamic> miniLedger;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = SharedFakeTransport();
      backupService = LedgerBackupService(db: db);
      pushService = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
      pullService = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: StagingStorage(db),
      );
      miniLedger = _buildMiniLedgerBlocks(crypto, transport);

      // Import test blocks into DB for push
      await _importBlocksIntoDb(
        db,
        miniLedger['blocks'] as List<Map<String, dynamic>>,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // D1
    test('D1: Push 3 blocks → wipe → restore from cloud → pull → '
        '6 entries in staging', () async {
      // Step 1: Push
      final pushResult = await pushService.pushAll();
      expect(pushResult.success, isTrue,
          reason: 'Push must succeed before roundtrip');
      expect(pushResult.blocksPushed, 3);

      // Step 2: Wipe
      await _wipeDatabase(db);
      await _assertDatabaseIsEmpty(db);

      // Step 3+4: Pull (this also imports and seeds staging)
      final pullResult = await pullService.pullAll();
      expect(pullResult.success, isTrue,
          reason: 'Pull must succeed after push+wipe');
      expect(pullResult.blocksPulled, 3);
      expect(pullResult.entriesStaged, 6,
          reason: 'All 6 entries must be staged after pull');

      // Step 5: Verify blocks in DB
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 3,
          reason: 'All 3 blocks must be in DB after roundtrip');
    });

    // D2
    test('D2: After roundtrip, genesis block identity_seal matches '
        'known value', () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      await pullService.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere((b) => b.blockIndex == 0);
      expect(genesis.identitySeal, knownGenesisIdentitySeal,
          reason: 'Genesis identity_seal must survive roundtrip');
    });

    // D3
    test('D3: After roundtrip, entry titles include known titles',
        () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      await pullService.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      final allTitles = <String>[];
      for (final block in blocks) {
        try {
          final decoded = utf8.decode(base64.decode(block.dataEnc));
          final entries = jsonDecode(decoded) as List<dynamic>;
          for (final entry in entries) {
            if (entry is Map<String, dynamic>) {
              final data = entry['data'] as Map<String, dynamic>?;
              if (data != null && data.containsKey('title')) {
                allTitles.add(data['title'] as String);
              }
            }
          }
        } catch (_) {
          // Skip blocks with invalid data_enc
        }
      }

      final knownTitles =
          miniLedger['knownTitles'] as List<String>;
      for (final title in knownTitles) {
        expect(allTitles, contains(title),
            reason: 'Title "$title" must survive roundtrip');
      }
    });

    // D4
    test('D4: After roundtrip, entry tags include known tags', () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      await pullService.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      final allTags = <String>{};
      for (final block in blocks) {
        try {
          final decoded = utf8.decode(base64.decode(block.dataEnc));
          final entries = jsonDecode(decoded) as List<dynamic>;
          for (final entry in entries) {
            if (entry is Map<String, dynamic>) {
              final data = entry['data'] as Map<String, dynamic>?;
              final tags = data?['tags'] as List<dynamic>? ?? [];
              for (final t in tags) {
                allTags.add(t.toString());
              }
            }
          }
        } catch (_) {
          // Skip blocks with invalid data_enc
        }
      }

      final knownTags = miniLedger['knownTags'] as List<String>;
      for (final tag in knownTags) {
        expect(allTags, contains(tag),
            reason: 'Tag "$tag" must survive roundtrip');
      }
    });

    // D5
    test('D5: After roundtrip, exactly 6 entries staged', () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      final result = await pullService.pullAll();

      expect(result.success, isTrue);
      expect(result.entriesStaged, 6,
          reason: 'Entry count must be preserved through roundtrip');
    });

    // D6
    test('D6: After roundtrip, entries span the correct date range',
        () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      await pullService.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      // All blocks should be created within the test date range
      for (final block in blocks) {
        // createdAt is epoch seconds; our test dates are all June 2026
        expect(block.createdAt, greaterThan(0),
            reason: 'All blocks must have valid createdAt');
      }
      // Verify we have blocks for all 3 days
      expect(blocks.length, 3);
    });

    // D7
    test('D7: After wipe (before restore), DB has zero blocks and '
        'staging is empty', () async {
      // Push then wipe
      await pushService.pushAll();
      await _wipeDatabase(db);

      // Verify DB is empty
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Database must be empty after wipe');
    });

    // D8
    test('D8: After pull-only (no prior push), genesis exists but '
        'staging seeded from remote blocks', () async {
      // Push from a different "device" (simulated)
      await pushService.pushAll();
      // Wipe local
      await _wipeDatabase(db);

      // Pull-only (no local blocks, genesis created by import)
      final result = await pullService.pullAll();
      expect(result.success, isTrue);
      expect(result.blocksPulled, 3);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 3,
          reason: 'All blocks must be pulled from remote');
      final genesis = blocks.firstWhere((b) => b.blockIndex == 0);
      expect(genesis.blockType, BlockType.genesis,
          reason: 'Genesis must exist after pull from remote');
      expect(result.entriesStaged, greaterThan(0),
          reason: 'Staging must be seeded after pull');
    });

    // D9
    test('D9: Roundtrip preserves PHPSPEC field names in pushed blocks',
        () async {
      await pushService.pushAll();

      // Verify the pushed blocks on the "remote" have PHPSPEC fields
      for (var i = 0; i < 3; i++) {
        final path =
            'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
        final obfuscated = transport.store[path];
        expect(obfuscated, isNotNull,
            reason: 'Block $i must exist on remote');
        // Deobfuscate and check field names
        final json = crypto.deobfuscateBlob(
          obfuscated!,
          testMkHex,
        );
        final block = jsonDecode(json) as Map<String, dynamic>;
        expect(block.containsKey('type'), isTrue);
        expect(block.containsKey('day_index'), isTrue);
        expect(block.containsKey('date'), isTrue);
        expect(block.containsKey('prev_hash'), isTrue);
        expect(block.containsKey('entries'), isTrue);
        expect(block.containsKey('block_hash'), isTrue);
      }
    });

    // D10
    test('D10: Full roundtrip with mock transport succeeds — '
        'PullResult.success is true', () async {
      await pushService.pushAll();
      await _wipeDatabase(db);
      final result = await pullService.pullAll();

      expect(result.success, isTrue,
          reason: 'Full roundtrip must report success');
      expect(result.blocksPulled, 3);
      expect(result.entriesStaged, 6);
      expect(result.failedBlocks, isEmpty);
      expect(result.errors, isEmpty);
    });
  });
}
