import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3/sqlite3.dart' as sqlite;

import '../../core/models/block.dart';
import '../../core/models/entry.dart';
import 'index_entry.dart';
import 'row.dart';

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const int _currentSchemaVersion = 2;
const String _metaTable = '_phpoc_meta';
const String _metaKey = 'schema_version';

const String _sqlCreateV1 = '''
CREATE TABLE IF NOT EXISTS entries (
  entry_id      TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  start_epoch   INTEGER NOT NULL,
  end_epoch     INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  committed     INTEGER NOT NULL DEFAULT 0,
  device_uuid   TEXT,
  content_hash  TEXT,
  metadata_enc  TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  pauses        TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL DEFAULT ((strftime('%s', 'now') * 1000)),
  updated_at    INTEGER NOT NULL DEFAULT ((strftime('%s', 'now') * 1000))
);

CREATE TABLE IF NOT EXISTS blocks (
  block_id      TEXT PRIMARY KEY,
  block_type    TEXT NOT NULL,
  block_index   INTEGER NOT NULL UNIQUE,
  key_version   INTEGER NOT NULL DEFAULT 1,
  data_enc      TEXT NOT NULL,
  identity_seal TEXT,
  prev_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT ((strftime('%s', 'now') * 1000))
);

CREATE TABLE IF NOT EXISTS index_entries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id  TEXT NOT NULL,
  date      TEXT NOT NULL,
  tag       TEXT NOT NULL,
  entry_id  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS $_metaTable (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_is_active   ON entries(is_active);
CREATE INDEX IF NOT EXISTS idx_entries_committed   ON entries(committed);
CREATE INDEX IF NOT EXISTS idx_entries_start_epoch ON entries(start_epoch);
CREATE INDEX IF NOT EXISTS idx_blocks_block_type   ON blocks(block_type);
CREATE INDEX IF NOT EXISTS idx_blocks_block_index  ON blocks(block_index);
CREATE INDEX IF NOT EXISTS idx_index_entries_date  ON index_entries(date);
CREATE INDEX IF NOT EXISTS idx_index_entries_tag   ON index_entries(tag);
CREATE INDEX IF NOT EXISTS idx_index_entries_block ON index_entries(block_id);
''';

// ────────────────────────────────────────────────────────────
// Database
// ────────────────────────────────────────────────────────────

class AppDatabase {
  final sqlite.Database _db;
  int _cachedVersion = 0;
  final int? _openVersion;
  bool _isClosed = false;

  late final EntryDao entryDao = EntryDao(this);
  late final BlockDao blockDao = BlockDao(this);
  late final IndexEntryDao indexEntryDao = IndexEntryDao(this);

  AppDatabase._(this._db, {this._openVersion}) {
    _initialize();
  }

  static const int supportedSchemaVersion = _currentSchemaVersion;
  int get schemaVersion => _cachedVersion;
  bool get isOpen => !_isClosed;

  // ── Public query API ─────────────────────────────────────

  SelectResult customSelect(String query, {List<Object?>? variables}) {
    final result = _db.select(query, variables ?? const []);
    final rows = result.map((r) => Row(_rowToMap(r, result.columnNames))).toList();
    return SelectResult(rows);
  }

  Map<String, Object?> _rowToMap(sqlite.Row row, List<String> columns) {
    final map = <String, Object?>{};
    for (var i = 0; i < columns.length; i++) {
      map[columns[i]] = row[i];
    }
    return map;
  }

  Future<void> customStatement(String statement, [List<Object?>? args]) {
    return Future.sync(() => _db.execute(statement, args ?? const []));
  }

  /// Synchronous version of [customStatement] for use by the ledger engine.
  void customStatementSync(String statement, [List<Object?>? args]) {
    _db.execute(statement, args ?? const []);
  }

  // ── Seed vault helpers ──────────────────────────────────

  /// Store a PDK-encrypted recovery seed in the _phpoc_meta table.
  ///
  /// Uses INSERT OR REPLACE — repeated calls overwrite the previous value
  /// (required for changePassphrase which re-encrypts with a new PDK).
  Future<void> setSeedVault(String encryptedSeed) async {
    await customStatement(
      'INSERT OR REPLACE INTO _phpoc_meta (key, value) VALUES (?, ?)',
      ['recovery_seed_enc', encryptedSeed],
    );
  }

  /// Read the PDK-encrypted recovery seed from the _phpoc_meta table,
  /// or null if no seed has been stored.
  Future<String?> getSeedVault() async {
    final rows = customSelect(
      'SELECT value FROM _phpoc_meta WHERE key = ?',
      variables: ['recovery_seed_enc'],
    ).get();
    return rows.isNotEmpty ? rows.first.read<String>('value') : null;
  }

  int _executeAndGetChanges(String sql, [List<Object?>? args]) {
    _db.execute(sql, args ?? const []);
    return _db.select('SELECT changes() AS cnt', []).first[0] as int;
  }

  Future<T> transaction<T>(Future<T> Function() action) async {
    _db.execute('BEGIN EXCLUSIVE');
    try {
      final result = await action();
      _db.execute('COMMIT');
      return result;
    } catch (e) {
      _db.execute('ROLLBACK');
      rethrow;
    }
  }

  // ── Internal helpers for DAOs ────────────────────────────

  List<Row> _selectOne(String sql, String value) {
    return customSelect(sql, variables: <Object?>[value]).get();
  }

  List<Row> _selectTwoInt(String sql, int a, int b) {
    return customSelect(sql, variables: <Object?>[a, b]).get();
  }

  // ── Initialization ───────────────────────────────────────

  void _initialize() {
    if (_cachedVersion > 0 && _openVersion == null) return;
    final version = _openVersion ?? _currentSchemaVersion;

    final hasMeta = _tableExists(_metaTable);
    if (!hasMeta) {
      _runSql(_sqlCreateV1);
      _runSql(
        'INSERT OR REPLACE INTO $_metaTable (key, value) VALUES (?, ?)',
        [_metaKey, version.toString()],
      );
      _cachedVersion = version;
    } else {
      final rows = _db.select(
        'SELECT value FROM $_metaTable WHERE key = ?', [_metaKey],
      );
      _cachedVersion = rows.isEmpty
          ? _currentSchemaVersion
          : int.parse(rows.first[0] as String);

      if (_cachedVersion < _currentSchemaVersion && _openVersion == null) {
        _runMigrations(_cachedVersion, _currentSchemaVersion);
        _cachedVersion = _currentSchemaVersion;
      }
      if (_openVersion != null) {
        _cachedVersion = _openVersion;
      }
    }

    try {
      final jm = _db.select('PRAGMA journal_mode', []);
      final mode = (jm.first[0] as String).toLowerCase();
      if (mode != 'wal' && mode != 'memory') {
        _runSql('PRAGMA journal_mode=WAL');
      }
    } catch (_) {}
    try {
      _runSql('PRAGMA foreign_keys=ON');
    } catch (_) {}
  }

  bool _tableExists(String table) {
    try {
      final rows = _db.select(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [table],
      );
      return rows.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  void _runSql(String sql, [List<Object?>? args]) {
    _db.execute(sql, args ?? const []);
  }

  // ── Migrations ───────────────────────────────────────────

  static final Map<int, List<String>> _migrations = {};

  void _runMigrations(int from, int to) {
    for (var v = from + 1; v <= to; v++) {
      final stmts = _migrations[v];
      if (stmts != null) {
        for (final sql in stmts) {
          _runSql(sql);
        }
      }
      _runSql(
        'INSERT OR REPLACE INTO $_metaTable (key, value) VALUES (?, ?)',
        [_metaKey, v.toString()],
      );
    }
  }

  // ── Pre-resolved path (set in main.dart before runApp) ───

  /// Set by [setDatabasePath] before [runApp].
  /// Read by [providers.dart] to decide file vs in-memory.
  static String? preResolvedPath;

  /// Set the database file path before [runApp].
  /// Call from main() after [getApplicationDocumentsDirectory].
  static void setDatabasePath(String path) {
    preResolvedPath = path;
  }

  // ── Factories ────────────────────────────────────────────

  static Future<AppDatabase> openAtVersion(int version) async {
    if (version > _currentSchemaVersion) {
      throw Exception(
        'Cannot open at version $version — '
        'supported schema version is $_currentSchemaVersion',
      );
    }
    final sqliteDb = sqlite.sqlite3.openInMemory();
    return AppDatabase._(sqliteDb, openVersion: version);
  }

  Future<void> migrateToVersion(int targetVersion) async {
    if (targetVersion > _currentSchemaVersion) {
      throw Exception(
        'Cannot migrate to version $targetVersion — '
        'supported schema version is $_currentSchemaVersion',
      );
    }
    if (_cachedVersion >= targetVersion) return;
    _runMigrations(_cachedVersion, targetVersion);
    _cachedVersion = targetVersion;
  }

  factory AppDatabase.inMemory() {
    final sqliteDb = sqlite.sqlite3.openInMemory();
    return AppDatabase._(sqliteDb);
  }

  /// Synchronous file-based factory. Requires [setDatabasePath] to be
  /// called first (typically in main.dart before runApp).
  factory AppDatabase.openSync(String path) {
    final sqliteDb = sqlite.sqlite3.open(path);
    return AppDatabase._(sqliteDb);
  }

  static Future<AppDatabase> open() async {
    final dir = await getApplicationDocumentsDirectory();
    final dbPath = p.join(dir.path, 'phpoc.db');
    final sqliteDb = sqlite.sqlite3.open(dbPath);
    return AppDatabase._(sqliteDb);
  }

  Future<void> close() async {
    _isClosed = true;
    _db.dispose();
  }
}

// ────────────────────────────────────────────────────────────
// DAO: EntryDao
// ────────────────────────────────────────────────────────────

class EntryDao {
  final AppDatabase _db;
  EntryDao(this._db);

  Future<Entry> insertEntry(Entry entry) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await _db.customStatement('''
      INSERT INTO entries (entry_id, title, start_epoch, end_epoch, is_active,
                           committed, device_uuid, content_hash, metadata_enc,
                           tags, pauses, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', [
      entry.entryId, entry.title, entry.startEpoch, entry.endEpoch,
      entry.isActive ? 1 : 0, entry.committed ? 1 : 0,
      entry.deviceUuid, entry.contentHash, entry.metadataEnc,
      jsonEncode(entry.tags),
      jsonEncode(entry.pauses.map((p) => p.toJson()).toList()),
      now, now,
    ]);
    return entry.copyWith();
  }

  Future<Entry?> getEntry(String id) async {
    final rows = _db._selectOne('SELECT * FROM entries WHERE entry_id = ?', id);
    if (rows.isEmpty) return null;
    return _rowToEntry(rows.first);
  }

  Future<List<Entry>> getAllEntries() async {
    final rows = _db.customSelect(
      'SELECT * FROM entries ORDER BY start_epoch DESC',
    ).get();
    return rows.map(_rowToEntry).toList();
  }

  Future<List<Entry>> getActiveEntries() async {
    final rows = _db.customSelect(
      'SELECT * FROM entries WHERE is_active = 1 ORDER BY start_epoch DESC',
    ).get();
    return rows.map(_rowToEntry).toList();
  }

  Future<List<Entry>> getEntriesByDateRange({
    required int from,
    required int to,
  }) async {
    final rows = _db._selectTwoInt(
      'SELECT * FROM entries WHERE start_epoch >= ? AND start_epoch <= ? ORDER BY start_epoch DESC',
      from, to,
    );
    return rows.map(_rowToEntry).toList();
  }

  Future<List<Entry>> getEntriesByTag(String tag) async {
    final rows = _db._selectOne(
      '''SELECT e.* FROM entries e, json_each(e.tags) jt
         WHERE jt.value = ? ORDER BY e.start_epoch DESC''',
      tag,
    );
    return rows.map(_rowToEntry).toList();
  }

  Future<List<Entry>> getUncommittedEntries() async {
    final rows = _db.customSelect(
      'SELECT * FROM entries WHERE committed = 0 ORDER BY start_epoch DESC',
    ).get();
    return rows.map(_rowToEntry).toList();
  }

  Future<bool> updateEntry(String id, Map<String, dynamic> updates) async {
    if (updates.isEmpty) return false;
    final setClauses = <String>[];
    final values = <Object?>[];
    for (final e in updates.entries) {
      final col = _snakeCase(e.key);
      final val = e.value;
      setClauses.add('$col = ?');
      if (val is bool) {
        values.add(val ? 1 : 0);
      } else if (val is List) {
        values.add(jsonEncode(val));
      } else {
        values.add(val);
      }
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    setClauses.add('updated_at = ?');
    values.add(now);
    values.add(id);
    final sql = 'UPDATE entries SET ${setClauses.join(', ')} WHERE entry_id = ?';
    final count = _db._executeAndGetChanges(sql, values);
    return count > 0;
  }

  Future<int> deleteEntry(String id) async {
    return _db._executeAndGetChanges('DELETE FROM entries WHERE entry_id = ?', [id]);
  }

  Future<int> getEntryCount() async {
    return _db.customSelect('SELECT COUNT(*) AS cnt FROM entries').get().first.read<int>('cnt');
  }

  Entry _rowToEntry(Row row) {
    return Entry(
      entryId: row.read<String>('entry_id'),
      title: row.read<String>('title'),
      startEpoch: row.read<int>('start_epoch'),
      endEpoch: row.read<int?>('end_epoch'),
      isActive: row.read<int>('is_active') == 1,
      committed: row.read<int>('committed') == 1,
      deviceUuid: row.read<String?>('device_uuid'),
      contentHash: row.read<String?>('content_hash'),
      metadataEnc: row.read<String?>('metadata_enc'),
      tags: _parseTags(row.read<String>('tags')),
      pauses: _parsePauses(row.read<String>('pauses')),
    );
  }

  List<T> _parseJson<T>(String raw, T Function(dynamic) convert) {
    if (raw.isEmpty) return [];
    return (jsonDecode(raw) as List<dynamic>).map(convert).toList();
  }

  List<String> _parseTags(String raw) => _parseJson(raw, (v) => v as String);

  List<PauseRecord> _parsePauses(String raw) =>
      _parseJson(raw, (v) => PauseRecord.fromJson(v as Map<String, dynamic>));

  String _snakeCase(String camel) {
    return camel.replaceAllMapped(
      RegExp(r'([A-Z])'), (m) => '_${m.group(1)!.toLowerCase()}',
    );
  }
}

// ────────────────────────────────────────────────────────────
// DAO: BlockDao
// ────────────────────────────────────────────────────────────

class BlockDao {
  final AppDatabase _db;
  BlockDao(this._db);

  int _resolveCreatedAt(Block block) => block.createdAt > 0
      ? block.createdAt
      : DateTime.now().millisecondsSinceEpoch;

  Future<Block> insertBlock(Block block) async {
    final createdAt = _resolveCreatedAt(block);
    await _db.customStatement('''
      INSERT INTO blocks (block_id, block_type, block_index, key_version,
                          data_enc, identity_seal, prev_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', [
      block.blockId, block.blockType.name, block.blockIndex,
      block.keyVersion, block.dataEnc, block.identitySeal,
      block.prevHash, createdAt,
    ]);
    return block;
  }

  Future<Block?> getBlock(String id) async {
    final rows = _db._selectOne('SELECT * FROM blocks WHERE block_id = ?', id);
    if (rows.isEmpty) return null;
    return _rowToBlock(rows.first);
  }

  Future<List<Block>> getAllBlocks() async {
    final rows = _db.customSelect(
      'SELECT * FROM blocks ORDER BY block_index ASC',
    ).get();
    return rows.map(_rowToBlock).toList();
  }

  Future<List<Block>> getBlocksByType(BlockType type) async {
    final rows = _db._selectOne(
      'SELECT * FROM blocks WHERE block_type = ? ORDER BY block_index ASC',
      type.name,
    );
    return rows.map(_rowToBlock).toList();
  }

  Future<Block?> getLastBlock() async {
    final rows = _db.customSelect(
      'SELECT * FROM blocks ORDER BY block_index DESC LIMIT 1',
    ).get();
    if (rows.isEmpty) return null;
    return _rowToBlock(rows.first);
  }

  Future<int> getBlockCount() async {
    return _db.customSelect('SELECT COUNT(*) AS cnt FROM blocks').get().first.read<int>('cnt');
  }

  Block _rowToBlock(Row row) {
    final typeName = row.read<String>('block_type');
    final blockType = BlockType.values.asNameMap()[typeName];
    if (blockType == null) {
      throw StateError('Unknown block_type "$typeName" in database row ${row.read<String>('block_id')}');
    }
    return Block(
      blockId: row.read<String>('block_id'),
      blockType: blockType,
      blockIndex: row.read<int>('block_index'),
      keyVersion: row.read<int>('key_version'),
      dataEnc: row.read<String>('data_enc'),
      identitySeal: row.read<String?>('identity_seal'),
      prevHash: row.read<String>('prev_hash'),
      createdAt: row.read<int>('created_at'),
    );
  }

  // ── Sync wrappers for LedgerChain (synchronous API) ──────

  Block insertBlockSync(Block block) {
    final createdAt = _resolveCreatedAt(block);
    _db.customStatementSync(
      'INSERT INTO blocks (block_id, block_type, block_index, key_version,'
          ' data_enc, identity_seal, prev_hash, created_at)'
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        block.blockId, block.blockType.name, block.blockIndex,
        block.keyVersion, block.dataEnc, block.identitySeal,
        block.prevHash, createdAt,
      ],
    );
    return block;
  }

  List<Block> getAllBlocksSync() {
    final rows = _db.customSelect(
      'SELECT * FROM blocks ORDER BY block_index ASC',
    ).get();
    return rows.map(_rowToBlock).toList();
  }

  Block? getLastBlockSync() {
    final rows = _db.customSelect(
      'SELECT * FROM blocks ORDER BY block_index DESC LIMIT 1',
    ).get();
    if (rows.isEmpty) return null;
    return _rowToBlock(rows.first);
  }

  int getBlockCountSync() {
    return _db.customSelect('SELECT COUNT(*) AS cnt FROM blocks')
        .get()
        .first
        .read<int>('cnt');
  }

  void deleteBlockSync(String blockId) {
    _db.customStatementSync(
      'DELETE FROM blocks WHERE block_id = ?',
      [blockId],
    );
  }

  /// Delete all blocks (used during chain migration).
  void deleteAllBlocksSync() {
    _db.customStatementSync('DELETE FROM blocks', []);
  }
}

// ────────────────────────────────────────────────────────────
// DAO: IndexEntryDao
// ────────────────────────────────────────────────────────────

class IndexEntryDao {
  final AppDatabase _db;
  IndexEntryDao(this._db);

  Future<IndexEntry> insertIndexEntry(IndexEntry entry) async {
    await _db.customStatement('''
      INSERT INTO index_entries (block_id, date, tag, entry_id)
      VALUES (?, ?, ?, ?)
    ''', [entry.blockId, entry.date, entry.tag, entry.entryId]);
    final newId = _db.customSelect('SELECT last_insert_rowid() AS id').get().first.read<int>('id');
    return entry.withId(newId);
  }

  Future<List<IndexEntry>> getIndexEntriesByDate(String date) async {
    final rows = _db._selectOne('SELECT * FROM index_entries WHERE date = ?', date);
    return rows.map(_rowToIndexEntry).toList();
  }

  Future<List<IndexEntry>> getIndexEntriesByTag(String tag) async {
    final rows = _db._selectOne('SELECT * FROM index_entries WHERE tag = ?', tag);
    return rows.map(_rowToIndexEntry).toList();
  }

  Future<List<IndexEntry>> getIndexEntriesByBlockId(String blockId) async {
    final rows = _db._selectOne('SELECT * FROM index_entries WHERE block_id = ?', blockId);
    return rows.map(_rowToIndexEntry).toList();
  }

  Future<void> deleteIndexEntriesByBlockId(String blockId) async {
    await _db.customStatement('DELETE FROM index_entries WHERE block_id = ?', [blockId]);
  }

  Future<void> clearAllIndexEntries() async {
    await _db.customStatement('DELETE FROM index_entries');
  }

  IndexEntry _rowToIndexEntry(Row row) {
    return IndexEntry(
      id: row.read<int>('id'),
      blockId: row.read<String>('block_id'),
      date: row.read<String>('date'),
      tag: row.read<String>('tag'),
      entryId: row.read<String>('entry_id'),
    );
  }
}

