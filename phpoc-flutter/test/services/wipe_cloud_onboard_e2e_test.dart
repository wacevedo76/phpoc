import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';

/// Wipe + Cloud Onboard — E2E tests against real Worker (Group E, 8 assertions).
///
/// Blueprint: docs/planning/flutter/WIPE_CLOUD_ONBOARD_PHASE1.md
///
/// These tests connect to the REAL Cloudflare Worker/R2 storage.
/// They require:
///   1. The test Worker to be deployed and reachable
///   2. TEST_CREDENTIALS.md credentials (Worker URL + API key)
///   3. The test ledger to have been pushed to R2 (run push E2E first)
///
/// Skip these tests with: flutter test --tags=-e2e
/// Run only these tests with: flutter test --tags=e2e
///
/// ⚠️ DO NOT commit secrets. Credentials must be passed via environment
/// or an external config file outside the repo.

// ── Test constants ─────────────────────────────────────────────

/// Must be set before running E2E tests. Use TEST_CREDENTIALS.md values.
String get _envWorkerUrl =>
    Platform.environment['PHPOC_WORKER_URL'] ?? '';
String get _envApiKey =>
    Platform.environment['PHPOC_API_KEY'] ?? '';

/// Test seed from TEST_CREDENTIALS.md.
/// MK derived via: SHA-256(seed_bytes) → hex
const _testSeedB64 = 'RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=';

/// Known genesis identity_seal from testdata/ledger.json
const _knownGenesisIdentitySeal =
    '9dbf0a3940fe5ce80c9a194043a3da30ad7082ad8edff38160fecda704231b18';

/// Known genesis block_hash from testdata/ledger.json
const _knownGenesisBlockHash =
    'e76a015a4e4830a4c760db63f17f4a3db4aaae3e463b49cd0fcbb6187b184922';

/// Whether E2E tests should run.
bool get _shouldRun =>
    _envWorkerUrl.isNotEmpty && _envApiKey.isNotEmpty;

/// Load the test ledger from disk and return parsed JSON string.
String _loadTestLedgerJson() {
  // Path relative to phpoc-flutter project root
  final path = '${Directory.current.path}/../testdata/ledger.json';
  final file = File(path);
  if (!file.existsSync()) {
    // Fallback: try from repo root via project dir
    final altPath = '${Directory.current.path}/testdata/ledger.json';
    final altFile = File(altPath);
    if (altFile.existsSync()) {
      return altFile.readAsStringSync();
    }
    throw FileSystemException('Test ledger not found at $path or $altPath');
  }
  return file.readAsStringSync();
}

/// Pre-populate the in-memory DB with the test ledger.
Future<void> _populateDb(AppDatabase db) async {
  final backupService = LedgerBackupService(db: db);
  final json = _loadTestLedgerJson();
  await backupService.importFromJson(json);
}

/// Derive MK from the test seed.
String _deriveMkHex(CryptoService crypto) {
  // SHA-256 of raw seed bytes → 64-char hex MK
  final seedBytes = base64.decode(_testSeedB64);
  final seedHex = seedBytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  return crypto.sha256(seedHex);
}

// ═══════════════════════════════════════════════════════════════
// Group E: E2E against Real Worker
// ═══════════════════════════════════════════════════════════════

void main() {
  group('E: Wipe + Cloud Onboard — E2E (Real Worker)', () {
    late AppDatabase db;
    late CryptoService crypto;
    late HttpTransport transport;
    late LedgerPushService pushService;
    late LedgerPullService pullService;
    late LedgerBackupService backupService;
    late String mkHex;

    setUpAll(() {
      if (!_shouldRun) {
        return;
      }
    });

    setUp(() async {
      if (!_shouldRun) return;

      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      mkHex = _deriveMkHex(crypto);
      crypto.setMasterKey(mkHex);

      transport = HttpTransport(
        baseUrl: _envWorkerUrl,
        apiKey: _envApiKey,
      );

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
        stagingStore: StagingStore(db),
      );

      // Pre-populate DB with test ledger before pushAll/pullAll
      await _populateDb(db);
    });

    tearDown(() async {
      if (!_shouldRun) return;
      await db.close();
    });

    // ── Helper: skip if no credentials ─────────────────────────
    final _skip = !_shouldRun;
    final _skipReason =
        'Set PHPOC_WORKER_URL and PHPOC_API_KEY env vars to run E2E tests';

    // E1
    test('E1: Push 31 blocks to real Worker → pull all back → '
        '31 blocks in DB', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      // Push first (from existing testdata/ledger.json already on R2,
      // this may be a no-op if already pushed)
      await pushService.pushAll();

      // Pull all blocks
      final result = await pullService.pullAll();

      expect(result.success, isTrue,
          reason: 'Pull from real Worker must succeed');
      expect(result.blocksPulled, 31,
          reason: 'All 31 blocks must be pulled from real Worker');

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 31,
          reason: 'All 31 blocks must be in DB after pull');
    });

    // E2
    test('E2: Real Worker roundtrip: push → wipe → restoreFromCloud '
        '→ pullAll → 146 entries', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      // Push
      await pushService.pushAll();

      // Wipe local DB
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM entries');
      await db.customStatement('DELETE FROM blocks');

      // Pull from remote (replaces wipe with cloud data)
      final result = await pullService.pullAll();

      expect(result.success, isTrue);
      expect(result.entriesStaged, 146,
          reason: 'All 146 entries from test ledger must be staged');
    });

    // E3
    test('E3: After real Worker roundtrip, entry titles include '
        '"Working on Project Alpha" and "Evening Exercise"', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await pushService.pushAll();
      // Wipe and pull
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM entries');
      await db.customStatement('DELETE FROM blocks');
      await pullService.pullAll();

      // Extract all titles from blocks
      final blocks = await db.blockDao.getAllBlocks();
      final allTitles = <String>{};
      for (final block in blocks) {
        try {
          final decoded = utf8.decode(base64.decode(block.dataEnc));
          final entries = jsonDecode(decoded) as List<dynamic>;
          for (final entry in entries) {
            if (entry is Map<String, dynamic>) {
              final data = entry['data'] as Map<String, dynamic>?;
              final title = data?['title'] as String?;
              if (title != null && title.isNotEmpty) {
                allTitles.add(title);
              }
            }
          }
        } catch (_) {}
      }

      expect(allTitles, contains('Working on Project Alpha'),
          reason: 'Known title must survive real R2 roundtrip');
      expect(allTitles, contains('Evening Exercise'),
          reason: 'Known title must survive real R2 roundtrip');
    });

    // E4
    test('E4: After real Worker roundtrip, tags include "coding", '
        '"work", "exercise", "health"', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await pushService.pushAll();
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM entries');
      await db.customStatement('DELETE FROM blocks');
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
        } catch (_) {}
      }

      expect(allTags, contains('coding'),
          reason: 'Tag "coding" must survive real R2 roundtrip');
      expect(allTags, contains('work'),
          reason: 'Tag "work" must survive real R2 roundtrip');
      expect(allTags, contains('exercise'),
          reason: 'Tag "exercise" must survive real R2 roundtrip');
      expect(allTags, contains('health'),
          reason: 'Tag "health" must survive real R2 roundtrip');
    });

    // E5
    test('E5: Pull from real Worker → genesis block 0 → '
        'identity_seal matches known value', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await pushService.pushAll();
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM entries');
      await db.customStatement('DELETE FROM blocks');
      await pullService.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere(
        (b) => b.blockIndex == 0,
        orElse: () => throw StateError('Genesis block not found in DB'),
      );
      expect(genesis.identitySeal, _knownGenesisIdentitySeal,
          reason: 'Genesis identity_seal on R2 must match known value');
    });

    // E6
    test('E6: Pull hash_index.json from real Worker → genesis hash '
        'at [0] matches known value', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      // Push to ensure remote state is current
      await pushService.pushAll();

      final raw = await transport.pull('ledger/hash_index.json');
      expect(raw, isNotNull,
          reason: 'hash_index.json must exist on Worker');
      final parsed = jsonDecode(utf8.decode(raw!)) as List;
      expect(parsed.isNotEmpty, isTrue);
      expect(parsed[0], _knownGenesisBlockHash,
          reason: 'Genesis hash in hash_index must match known value');
    });

    // E7
    test('E7: Pull block 0 from real Worker → deobfuscate → '
        'type: "genesis", day_index: 0', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await pushService.pushAll();

      final raw = await transport.pull('ledger/blocks/000000.json');
      expect(raw, isNotNull,
          reason: 'Block 0 must exist on Worker');
      final decoded =
          crypto.deobfuscateBlob(raw!, mkHex);
      final json = jsonDecode(decoded) as Map<String, dynamic>;
      expect(json['type'], 'genesis',
          reason: 'Block 0 must be genesis type');
      expect(json['day_index'], 0,
          reason: 'Genesis must have day_index 0');
    });

    // E8
    test('E8: Pull block 30 from real Worker → deobfuscate → '
        '8 entries, type: "day", day_index: 30', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await pushService.pushAll();

      final raw = await transport.pull('ledger/blocks/000030.json');
      expect(raw, isNotNull,
          reason: 'Block 30 must exist on Worker');
      final decoded =
          crypto.deobfuscateBlob(raw!, mkHex);
      final json = jsonDecode(decoded) as Map<String, dynamic>;
      expect(json['type'], 'day',
          reason: 'Block 30 must be day type');
      expect(json['day_index'], 30,
          reason: 'Block 30 must have day_index 30');
      final entries = json['entries'] as List?;
      expect(entries, isNotNull);
      expect(entries!.length, 8,
          reason: 'Block 30 must have exactly 8 entries');
    });
  });
}
