import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// LedgerPushService E2E tests — Group I (6 assertions).
///
/// Blueprint: docs/planning/flutter/PUSH_TO_R2_PHASE1.md
///
/// These tests connect to the REAL Cloudflare Worker/R2 storage.
/// They require:
///   1. The test Worker to be deployed and reachable
///   2. TEST_CREDENTIALS.md credentials (Worker URL + API key)
///   3. A real master key derived from the test seed
///
/// Skip these tests with: flutter test --tags=-e2e
/// Run only these tests with: flutter test --tags=e2e
///
/// ⚠️ DO NOT commit secrets. Credentials must be passed via environment
/// or an external config file outside the repo.

// ── Test constants ─────────────────────────────────────────────

/// Must be set before running E2E tests. Use TEST_CREDENTIALS.md values.
const _envWorkerUrl = String.fromEnvironment(
  'PHPOC_WORKER_URL',
  defaultValue: '',
);
const _envApiKey = String.fromEnvironment(
  'PHPOC_API_KEY',
  defaultValue: '',
);

/// Test seed from TEST_CREDENTIALS.md.
/// MK derived via: SHA-256(seed_bytes) → hex
const _testSeedB64 = 'RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=';

/// Known genesis hash from the test ledger.
const _knownGenesisHash =
    'e718daf3ea681830b464207f4ddfe28594c4d6540e2a80dceec9fcf83bd4458b';

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
// Group I: E2E against Real Worker
// ═══════════════════════════════════════════════════════════════

void main() {
  group('I: LedgerPushService — E2E (Real Worker)', () {
    late AppDatabase db;
    late CryptoService crypto;
    late HttpTransport transport;
    late LedgerPushService service;
    late String mkHex;

    setUpAll(() {
      if (!_shouldRun) {
        // Allow tests to be skipped gracefully
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

      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );

      // Pre-populate DB with test ledger before pushAll
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

    // I1
    test('I1: Push test ledger (31 blocks) to real Worker → verify '
        '31 block files exist via prefix list', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await service.pushAll();

      final files = await transport.listFiles('ledger/blocks/');
      expect(files.length, 31,
          reason: 'All 31 blocks must be present in R2');
    });

    // I2
    test('I2: Push to real Worker → pull hash_index → genesis hash '
        'matches known value', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await service.pushAll();

      final raw = await transport.pull('ledger/hash_index.json');
      expect(raw, isNotNull,
          reason: 'hash_index.json must exist on Worker');
      final parsed = jsonDecode(utf8.decode(raw!)) as List;
      expect(parsed[0], _knownGenesisHash,
          reason: 'Genesis hash must match known test ledger genesis');
    });

    // I3
    test('I3: Push to real Worker → pull block 0 → deobfuscate → '
        'block type is "genesis"', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await service.pushAll();

      final raw = await transport.pull('ledger/blocks/000000.json');
      expect(raw, isNotNull);
      final decoded =
          crypto.deobfuscateBlob(raw!, mkHex);
      final json = jsonDecode(decoded) as Map<String, dynamic>;
      expect(json['type'], 'genesis',
          reason: 'Block 0 must be a genesis block');
    });

    // I4
    test('I4: Push to real Worker → pull block 15 → deobfuscate → '
        'entries array is non-empty', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await service.pushAll();

      final raw = await transport.pull('ledger/blocks/000015.json');
      expect(raw, isNotNull);
      final decoded =
          crypto.deobfuscateBlob(raw!, mkHex);
      final json = jsonDecode(decoded) as Map<String, dynamic>;
      final entries = json['entries'] as List?;
      expect(entries, isNotNull,
          reason: 'Block 15 must have an entries array');
      expect(entries!.length, greaterThan(0),
          reason: 'Block 15 must contain at least one entry');
    });

    // I5
    test('I5: Push to real Worker → listFiles shows both blocks/ '
        'and hash_index.json', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      await service.pushAll();

      // Worker ?prefix= API returns paths relative to the prefix.
      // ?prefix=ledger/ returns entries like 'blocks/000000.json',
      // 'hash_index.json', 'index.json'.
      final allFiles = await transport.listFiles('ledger/');
      final hasBlocks = allFiles.any((f) => f.startsWith('blocks/'));
      final hasHashIndex =
          allFiles.any((f) => f == 'hash_index.json');
      final hasIndex =
          allFiles.any((f) => f == 'index.json');

      expect(hasBlocks, isTrue,
          reason: 'Must have ledger/blocks/ files');
      expect(hasHashIndex, isTrue,
          reason: 'Must have hash_index.json');
      expect(hasIndex, isTrue,
          reason: 'Must have index.json');
    });

    // I6
    test('I6: Push to real Worker using TEST_CREDENTIALS → all 31 '
        'blocks pushed successfully', () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      final result = await service.pushAll();
      expect(result.success, isTrue,
          reason: 'Full push to real Worker must succeed');
      expect(result.blocksPushed, 31,
          reason: 'All 31 test ledger blocks must be pushed');
      expect(result.failedBlocks, isEmpty);
      expect(result.errors, isEmpty);
    });
  });
}
