import 'dart:async';
import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/sync_result.dart';
import '../../core/utils/format_utils.dart';
import '../ledger/engine.dart';
import '../ledger/helpers.dart' show getBlockHash;
import '../ledger/chain_reconcile.dart';
import 'activity_id.dart';
import 'device_cookie.dart';
import 'staging_paths.dart';
import 'genesis_gate.dart';
import 'merge_engine.dart';
import 'staging_hash_index.dart';
import 'staging_store.dart';
import 'transport.dart';

import '../../services/ledger_pull_service.dart';
import '../../services/ledger_push_service.dart';

/// Unified sync gate + local I/O for staging entries.
///
/// Port of web src/sync/sync.js and domain/staging/service.py.
///
/// Row-level staging: [stagingStore] (SQLite StagingStore) is **required** —
/// mutation wrappers use activity_id-based row operations with debounced
/// auto-push to R2. The legacy monolithic `LocalCache` blob path was retired
/// (Option A).
class SyncService {
  final dynamic storage;
  final CryptoService crypto;
  HttpTransport? transport;
  final StagingStore stagingStore;

  final DeviceCookie _cookie;
  final GenesisGate _genesisGate;
  LedgerEngine? ledgerEngine;

  /// Optional ledger sync delegates wired by the app layer (Phase 3/ADR-030).
  ///
  /// [ledgerPull] is invoked on an ownership-handoff reauth to refresh the
  /// ledger only when the remote block-count exceeds the local count.
  /// [ledgerPush] is invoked after [commitAndSync] seals a new block to
  /// auto-push the updated ledger to Remote (D11 move semantics).
  ///
  /// Null in phase 2 until the caller supplies them.
  final LedgerPullService? ledgerPull;
  final LedgerPushService? ledgerPush;

  int _lastPushAt = 0;
  String? _cachedDeviceUuid;

  // ── Debounce + periodic timer + status (row-level overhaul) ─

  Timer? _debounceTimer;

  /// Recurring drift-detection timer started via [startPeriodicSync].
  /// Each tick runs a guarded, fire-and-forget [checkAndSync] that forces
  /// past the F1 read-only fast path so remote staging drift is detected
  /// even when the local store has no pending writes. See
  /// docs/planning/flutter/PERIODIC_AUTO_SYNC_TIMER_PHASE1.md (Group P).
  Timer? _periodicTimer;
  bool _isSyncing = false;

  /// Set by [dispose] so a fire-and-forget periodic tick scheduled around
  /// teardown short-circuits instead of touching a closed DB / performing
  /// network after dispose (P7). [checkAndSync] returns `ready` once set, in
  /// line with the D15 no-op semantics.
  bool _disposed = false;
  final _syncStatusController = StreamController<SyncingStatus>.broadcast();

  SyncService({
    required this.storage,
    required this.crypto,
    required this.stagingStore,
    this.transport,
    this.ledgerEngine,
    this.ledgerPull,
    this.ledgerPush,
  }) : _cookie = DeviceCookie(),
       _genesisGate = GenesisGate() {
    // Emit initial inSync state for status listeners (G1)
    // Schedule after microtask so listeners can subscribe first
    Future.microtask(() {
      if (!_syncStatusController.isClosed) {
        _syncStatusController.add(SyncingStatus.inSync);
      }
    });
  }

  // ── Diagnostics ──────────────────────────────────────────────

  bool get isRemoteAvailable => transport != null;
  int get lastPushAt => _lastPushAt;
  bool get isSyncing => _isSyncing;
  Stream<SyncingStatus> get syncStatus => _syncStatusController.stream;

  /// Check whether there are uncommitted staging rows that need to be
  /// pushed to remote. Returns false when staging is empty or all rows
  /// are committed — used by F1 read-only fast path to skip network.
  Future<bool> hasPendingWrites() async {
    final rows = await stagingStore.getAllRows();
    return rows.any((r) => !_rowIsCommitted(r));
  }

  // ═════════════════════════════════════════════════════════════
  // Row-level mutation wrappers (new stagingStore path)
  // ═════════════════════════════════════════════════════════════

  /// Capture a new task. Returns the activity_id.
  ///
  /// Generates an activity_id, writes a row with status="active", and
  /// schedules a debounced push to R2.
  Future<String> capture({
    required String title,
    List<String>? tags,
    String? comment,
    Set<String> encryptFields = const {},
    int? startEpoch,
    bool isOneOff = false,
  }) async {
    final activityId = ActivityIdGenerator.generateActivityId();
    final resolvedEpoch = startEpoch ?? DateTime.now().millisecondsSinceEpoch;

    final activityData = _buildActivityData(
      title: title,
      startEpoch: resolvedEpoch,
      tags: tags ?? [],
      comment: comment,
      isActive: !isOneOff,
      endEpoch: isOneOff ? resolvedEpoch + 1000 : null,
      duration: isOneOff ? 1000 : 0,
      encryptFields: encryptFields,
    );

    await stagingStore.putRow({
      'activity_id': activityId,
      'activity_status': isOneOff ? 'ended' : 'active',
      'activity': json.encode(activityData),
      'updated_at': DateTime.now().millisecondsSinceEpoch,
      // Extra fields required by LedgerEngine.commit for F9
      'title': title,
      'start_epoch': resolvedEpoch,
      'duration': isOneOff ? 1000 : 0,
      'end_epoch': isOneOff ? resolvedEpoch + 1000 : null,
      'tags': tags ?? [],
      'pauses': [],
      'one_off': isOneOff,
      'has_encrypted_fields': encryptFields.isNotEmpty,
    });

    await _afterMutation();
    return activityId;
  }

  /// End a task by activity_id.
  Future<void> end(String activityId, int endEpoch) async {
    final row = await stagingStore.getRow(activityId);
    final resolved = row ?? await _resolveRowByTitle(activityId);
    if (resolved == null) {
      throw Exception('No active task found for: $activityId');
    }

    final activityData = _decodeActivityBlob(resolved['activity'] as String?);
    // Close any open pause (pause_stop == null) at end time.
    final pauses = List<Map<String, dynamic>>.from(
      (activityData['pauses'] as List?) ?? [],
    );
    if (pauses.isNotEmpty && pauses.last['pause_stop'] == null) {
      final last = Map<String, dynamic>.from(pauses.last);
      last['pause_stop'] = endEpoch;
      pauses[pauses.length - 1] = last;
    }
    activityData['end_epoch'] = endEpoch;
    activityData['is_active'] = false;
    activityData['end_device_uuid'] = _getDeviceUuid();
    final startEpoch = activityData['start_epoch'] as int? ?? 0;
    final duration = FormatUtils.computeDurationMsec(
      startEpoch,
      endEpoch,
      pauses,
    );
    activityData['duration'] = duration;
    activityData['pauses'] = pauses;

    resolved['activity_status'] = 'ended';
    resolved['activity'] = json.encode(activityData);
    resolved['end_epoch'] = endEpoch;
    resolved['duration'] = duration;
    resolved['pauses'] = pauses;

    await stagingStore.putRow(resolved);
    await _afterMutation();
  }

  /// Pause a task by activity_id.
  Future<void> pause(String activityId, int pauseEpoch) async {
    final row = await stagingStore.getRow(activityId);
    final resolved = row ?? await _resolveRowByTitle(activityId);
    if (resolved == null) {
      throw Exception('No active task found for: $activityId');
    }

    final activityData = _decodeActivityBlob(resolved['activity'] as String?);
    final pauses = List<Map<String, dynamic>>.from(
      (activityData['pauses'] as List?) ?? [],
    );
    pauses.add({'pause_start': pauseEpoch, 'pause_stop': null});
    activityData['pauses'] = pauses;
    activityData['is_paused'] = true;

    resolved['activity_status'] = 'paused';
    resolved['activity'] = json.encode(activityData);
    resolved['pauses'] = pauses;

    await stagingStore.putRow(resolved);
    await _afterMutation();
  }

  /// Unpause a task by activity_id.
  Future<void> unpause(String activityId, int unpauseEpoch) async {
    final row = await stagingStore.getRow(activityId);
    final resolved = row ?? await _resolveRowByTitle(activityId);
    if (resolved == null) {
      throw Exception('No active task found for: $activityId');
    }

    final activityData = _decodeActivityBlob(resolved['activity'] as String?);
    final pauses = List<Map<String, dynamic>>.from(
      (activityData['pauses'] as List?) ?? [],
    );
    if (pauses.isNotEmpty) {
      final last = Map<String, dynamic>.from(pauses.last);
      if (last['pause_stop'] == null) {
        last['pause_stop'] = unpauseEpoch;
        pauses[pauses.length - 1] = last;
      }
    }
    activityData['pauses'] = pauses;
    activityData['is_paused'] = false;

    resolved['activity_status'] = 'active';
    resolved['activity'] = json.encode(activityData);
    resolved['pauses'] = pauses;

    await stagingStore.putRow(resolved);
    await _afterMutation();
  }

  /// Modify a staged entry's fields.
  ///
  /// When [activityIdOrIndex] is [int], maps to legacy index-based modify
  /// (adapter for K4). When [String], uses as activity_id directly.
  Future<void> modify(
    dynamic activityIdOrIndex,
    Map<String, dynamic> fields, {
    Set<String> encryptFields = const {},
  }) async {
    if (activityIdOrIndex is String) {
      final row = await stagingStore.getRow(activityIdOrIndex);
      final resolved = row ?? await _resolveRowByTitle(activityIdOrIndex);
      if (resolved == null) return;

      final activityData = _decodeActivityBlob(resolved['activity'] as String?);

      // Merge fields into activity data
      for (final key in fields.keys) {
        activityData[key] = fields[key];
      }

      // Update has_encrypted_fields based on encryptFields (non-empty = true)
      if (encryptFields.isNotEmpty) {
        activityData['has_encrypted_fields'] = true;
        resolved['has_encrypted_fields'] = true;
      }

      resolved['activity'] = json.encode(activityData);
      // Also update top-level fields for LedgerEngine.commit
      for (final key in fields.keys) {
        resolved[key] = fields[key];
      }

      await stagingStore.putRow(resolved);
      await _afterMutation();
      return;
    }

    if (activityIdOrIndex is int) {
      // K4: index-based adapter → map to activity_id
      final all = await stagingStore.getAllRows();
      final index = activityIdOrIndex;
      if (index < 0 || index >= all.length) return;
      final activityId = all[index]['activity_id'] as String;
      await modify(activityId, fields, encryptFields: encryptFields);
    }
  }

  /// Remove a staged entry by activity_id (or index for legacy compat).
  ///
  /// A delete is authoritative local intent, so it must also be reflected on
  /// the remote: simply deleting the LOCAL row lets the next
  /// [_reconcileAndClaimRowLevel] pull the stale remote `staging/blob` and
  /// resurrect the entry (mergeEntries treats a remote-only row as
  /// authoritative). To converge to "deleted", push the remaining local
  /// staging to remote (which overwrites the blob WITHOUT the deleted row)
  /// before scheduling the debounced auto-sync — mirroring the commit-move
  /// pattern in [commitAndSync]. Best-effort: if the push fails (offline) the
  /// local delete still stands and the normal auto-sync retries.
  Future<void> remove(dynamic activityIdOrIndex) async {
    String? removedId;
    if (activityIdOrIndex is String) {
      await stagingStore.deleteRow(activityIdOrIndex);
      removedId = activityIdOrIndex;
    } else if (activityIdOrIndex is int) {
      // Index-based adapter → map to activity_id (legacy compat for K5).
      final all = await stagingStore.getAllRows();
      final index = activityIdOrIndex;
      if (index < 0 || index >= all.length) return;
      removedId = all[index]['activity_id'] as String?;
      await stagingStore.deleteRow(removedId!);
    }

    // Tombstone propagate: drop the deleted row from the remote blob so the
    // next reconcile does not resurrect it (delete-vs-sync race). Idempotent
    // with the debounced auto-sync that follows in [_afterMutation].
    if (removedId != null && transport != null && crypto.hasMasterKey) {
      try {
        await _pushStagingRowsToRemote();
      } catch (_) {
        // Best-effort: offline push leaves the deletion pending; the
        // debounced auto-sync will retry the reconcile.
      }
    }

    if (removedId != null) {
      await _afterMutation();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // Queries (legacy compat — K1, K2, K3)
  // ═════════════════════════════════════════════════════════════

  /// Read all staging entries as flat DTO list (K1).
  Future<List<Map<String, dynamic>>> readEntries() async {
    final rows = await stagingStore.getAllRows();
    return rows.map(_stagingRowToDto).toList();
  }

  /// Get active entries (status="active" or "paused") — K2.
  Future<List<Map<String, dynamic>>> getActive() async {
    final activeRows = await stagingStore.getRowsByStatus('active');
    final pausedRows = await stagingStore.getRowsByStatus('paused');
    final rows = [...activeRows, ...pausedRows];
    return rows.map(_stagingRowToDto).toList();
  }

  /// Get all staging entries, optionally filtered by date range.
  Future<List<Map<String, dynamic>>> getEntries({
    DateTime? from,
    DateTime? to,
  }) async {
    final dtos = (await stagingStore.getAllRows())
        .map(_stagingRowToDto)
        .toList();

    if (from == null && to == null) return dtos;

    return dtos.where((entry) => _inDateRange(entry, from, to)).toList();
  }

  /// True when entry's start_epoch falls within [from]–[to] (inclusive).
  bool _inDateRange(Map<String, dynamic> entry, DateTime? from, DateTime? to) {
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final startDt = DateTime.fromMillisecondsSinceEpoch(
      startEpoch,
      isUtc: true,
    );
    if (from != null && startDt.isBefore(from)) return false;
    if (to != null) {
      final toEndOfDay = DateTime.utc(
        to.year,
        to.month,
        to.day,
        23,
        59,
        59,
        999,
      );
      if (startDt.isAfter(toEndOfDay)) return false;
    }
    return true;
  }

  /// Get completed entries (status="ended") with normalized date — K3.
  Future<List<Map<String, dynamic>>> getCompleted() async {
    final rows = await stagingStore.getRowsByStatus('ended');
    return rows.map((row) {
      final dto = _stagingRowToDto(row);
      final startEpoch = dto['start_epoch'] as int?;
      final dateStr = (startEpoch != null && startEpoch > 0)
          ? FormatUtils.epochToDateStr(startEpoch)
          : 'unknown';
      dto['date'] = dateStr;
      return dto;
    }).toList()..sort((a, b) {
      final aEpoch = a['start_epoch'] as int? ?? 0;
      final bEpoch = b['start_epoch'] as int? ?? 0;
      return bEpoch.compareTo(aEpoch);
    });
  }

  /// Convert a staging row to a flat DTO compatible with old consumers.
  Map<String, dynamic> _stagingRowToDto(Map<String, dynamic> row) {
    final activityData = _decodeActivityBlob(row['activity'] as String?);
    final activityId = row['activity_id'];

    // Detect encrypted sensitive fields (A1–A3)
    final titleEnc = activityData['title_enc'] as String?;
    final tagsEnc = activityData['tags_enc'] as String?;
    final commentEnc = activityData['comment_enc'] as String?;
    final isEncrypted =
        (titleEnc != null && titleEnc.isNotEmpty) ||
        (tagsEnc != null && tagsEnc.isNotEmpty) ||
        (commentEnc != null && commentEnc.isNotEmpty);

    // A8: when encrypted and no plaintext title, show [Encrypted]
    final plainTitle =
        activityData['title'] as String? ?? row['title'] as String? ?? '';
    final displayTitle = (isEncrypted && plainTitle.isEmpty)
        ? '[Encrypted]'
        : plainTitle;

    return {
      'activity_id': activityId,
      'entry_id': activityId, // bridge: dashboard uses entry_id
      'title': displayTitle,
      'start_epoch': activityData['start_epoch'] ?? row['start_epoch'] ?? 0,
      'end_epoch': activityData['end_epoch'] ?? row['end_epoch'],
      'duration': activityData['duration'] ?? row['duration'] ?? 0,
      'is_active': activityData['is_active'] ?? true,
      'is_paused': activityData['is_paused'] ?? false,
      'is_sensitive_encrypted': isEncrypted,
      'title_enc': titleEnc,
      'tags_enc': tagsEnc,
      'comment_enc': commentEnc,
      'pauses': activityData['pauses'] ?? row['pauses'] ?? [],
      'tags': activityData['tags'] ?? row['tags'] ?? [],
      'comment': activityData['comment'] ?? row['comment'] ?? '',
      'media': activityData['media'] ?? row['media'] ?? [],
      'device_uuid': activityData['device_uuid'] ?? '',
      'activity_status': row['activity_status'],
      'updated_at': row['updated_at'],
      'committed': activityData['committed'] ?? false,
      'one_off': row['one_off'] ?? activityData['one_off'] ?? false,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // Sync Gate
  // ═════════════════════════════════════════════════════════════

  Future<SyncCheckResult> checkAndSync({
    int cookieTtlMinutes = 30,
    bool skipReadOnlyFastPath = false,
  }) async {
    if (_disposed) return SyncCheckResult.ready; // no post-dispose state access (P7)
    if (transport == null) return SyncCheckResult.ready;

    try {
      final genesisResult = await _genesisGate.check();
      if (genesisResult != null) return SyncCheckResult.genesisMismatch;
    } catch (_) {
      return SyncCheckResult.offline;
    }

    if (!crypto.hasMasterKey) return SyncCheckResult.reauthNeeded;

    final localCookie = await _cookie.isValidLocally(
      storage,
      ttlMinutes: cookieTtlMinutes,
    );

    if (localCookie != null) {
      // F1: Read-only fast path — skip network when no pending writes.
      // Skipped when [skipReadOnlyFastPath] is set (auto-push after a
      // mutation): remove()/commit() can leave the LOCAL state clean while
      // the REMOTE is stale, so we must still reconcile (pull + push).
      final pending = await hasPendingWrites();
      if (!pending && !skipReadOnlyFastPath) {
        return SyncCheckResult.ready;
      }

      try {
        final remoteCookieBytes = await transport!.pull(
          StagingPaths.remoteDeviceCookie,
        );
        final remoteCookie = _cookie.parseRemote(remoteCookieBytes);

        if (remoteCookie != null) {
          if (_cookie.matches(localCookie, remoteCookie)) {
            // Cookie match → fast path (row-level hash-index comparison).
            await _fastPathRowLevel();
            _lastPushAt = DateTime.now().millisecondsSinceEpoch;
            return SyncCheckResult.ready;
          } else {
            await _cookie.destroyLocally(storage);
            return SyncCheckResult.reauthNeeded;
          }
        }
      } catch (_) {
        return SyncCheckResult.offline;
      }
    }

    // A2: distinguish expired cookie (→ reauth) from missing cookie (→ reconcile)
    if (localCookie == null) {
      final rawCookie = await storage.get('cookie');
      if (rawCookie != null) {
        // Cookie exists but TTL expired → clear and request reauth
        await _cookie.destroyLocally(storage);
        return SyncCheckResult.reauthNeeded;
      }
    }

    try {
      // ADR-030: ownership handoff detected (fresh claim; no prior cookie).
      // Refresh the ledger first (block-count gated), then reconcile staging
      // so the device sees BOTH last ledger and last staging state.
      await _reconcileLedgerOnHandoff();
      await _reconcileAndClaimRowLevel();
      return SyncCheckResult.ready;
    } catch (_) {
      return SyncCheckResult.offline;
    }
  }

  Future<void> initialPull() async {
    await _reconcileAndClaimRowLevel();
  }

  /// Pull remote staging rows from the row-level blob path.
  ///
  /// Reads [StagingPaths.remoteRowLevelBlob] and deobfuscates rows.
  Future<List<Map<String, dynamic>>> _pullRemoteBlob() async {
    try {
      final blob = await transport!.pull(StagingPaths.remoteRowLevelBlob);
      if (blob == null || !crypto.hasMasterKey) return [];

      final jsonStr = crypto.deobfuscateBlob(blob, crypto.getMasterKey()!);
      final decoded = StagingStore.safeJsonDecode(jsonStr);
      if (decoded != null && decoded['entries'] is List) {
        return (decoded['entries'] as List)
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
      }
    } catch (_) {}
    return [];
  }

  Future<void> _pushCookie(String deviceId) async {
    // Preserve existing specifier when one exists (R8: only extend TTL).
    // Generate new specifier only when no cookie exists yet.
    final localCookie = await storage.get('cookie');
    Map<String, dynamic>? cookie;
    if (localCookie is Map && localCookie['device_specifier'] != null) {
      // Cookie exists — preserve specifier, refresh creation_time only
      await storage.set('cookie', {
        'device_specifier': localCookie['device_specifier'],
        'creation_time': DateTime.now().millisecondsSinceEpoch,
      });
      cookie = {
        'device_uuid': deviceId,
        'device_specifier': localCookie['device_specifier'],
      };
    } else {
      // No cookie yet — create fresh
      cookie = await _cookie.create(deviceId, storage);
    }
    if (cookie != null) {
      final cookieJson = json.encode(cookie);
      await transport!.push(
        StagingPaths.remoteDeviceCookie,
        Uint8List.fromList(cookieJson.codeUnits),
      );
    }
  }

  /// Filter remote rows for merge: keep uncommitted rows always;
  /// keep committed rows only when they also exist locally (so the
  /// committed flag propagates from remote to local).
  List<Map<String, dynamic>> _filterRemoteRowsForMerge(
    List<Map<String, dynamic>> remoteRows,
    List<Map<String, dynamic>> localRows,
  ) {
    return remoteRows.where((r) {
      if (!_rowIsCommitted(r)) return true;
      final id = r['activity_id'] as String?;
      if (id == null) return false;
      return localRows.any((lr) => lr['activity_id'] == id);
    }).toList();
  }

  /// Apply the ADR-030 Scenario-5/6 ledger-aware cleanup to a merged row set.
  ///
  /// Committed rows are never candidates for the drop (so History/Dashboard
  /// display survives a handoff); only UNCOMMITTED rows whose `activity_id` is
  /// sealed in [ledgerIds] are removed. An empty [ledgerIds] is a strict no-op
  /// (fresh device / fail-safe). Delegates the pure id-set filter to
  /// [MergeEngine.dropLedgerCommitted] — the caller supplies only the
  /// uncommitted subset (Phase 1 decision).
  List<Map<String, dynamic>> _dropSealedUncommitted(
    List<Map<String, dynamic>> rows,
    Set<String> ledgerIds,
  ) {
    final keptIds = MergeEngine.dropLedgerCommitted(
      rows.where((r) => !_rowIsCommitted(r)).toList(),
      ledgerIds,
    ).map((r) => r['activity_id']).toSet();
    return rows.where(
      (r) => _rowIsCommitted(r) || keptIds.contains(r['activity_id']),
    ).toList();
  }

  /// Row-level reconcile: pull staging/blob, merge with mergeEntries(),
  /// write to StagingStore, push via _pushStagingRowsToRemote().
  ///
  /// No-op when no transport is configured.
  Future<void> _reconcileAndClaimRowLevel() async {
    if (transport == null) return;

    final remoteRows = await _pullRemoteBlob();
    final localRows = await stagingStore.getAllRows();

    // R4: filter remote committed rows that don't exist locally
    final activeRemoteRows = _filterRemoteRowsForMerge(remoteRows, localRows);

    // Merge: uses activity_id LWW
    final merged = MergeEngine.mergeEntries(localRows, activeRemoteRows);

    // ADR-030 Scenario-5/6 ledger-aware cleanup (SCENARIO56_WIRE_PHASE1.md):
    // on a fresh handoff claim the local ledger may already seal an
    // activity_id that a stale local scaffold still carries. Drop ONLY
    // UNCOMMITTED merged rows whose id is sealed so they are not re-pushed
    // as scratchpad; committed rows stay for History/Dashboard display. An
    // empty ledger set is a strict no-op (fresh device / backward compat).
    final ledgerIds = ledgerEngine?.ledgerActivityIds() ?? <String>{};
    final finalRows = _dropSealedUncommitted(merged, ledgerIds);

    // Build set of final activity_ids for local-only cleanup.
    final mergedIds = finalRows
        .map((r) => r['activity_id'] as String)
        .where((id) => id.isNotEmpty)
        .toSet();

    // Write final rows to StagingStore, preserving updated_at (LWW tiebreaker).
    // Committed entries stay in staging for History/Dashboard display;
    // the Sync tab filters them out via the committed flag.
    for (final row in finalRows) {
      await stagingStore.putRow(row, preserveUpdatedAt: true);
    }

    // Remove local-only rows that were filtered out by mergeEntries or by the
    // Scenario-5/6 cleanup. (mergeEntries keeps all local rows; the cleanup
    // drops sealed uncommitted rows; both are caught by !mergedIds.contains.)
    for (final localRow in localRows) {
      final id = localRow['activity_id'] as String?;
      if (id != null && !mergedIds.contains(id)) {
        await stagingStore.deleteRow(id);
      }
    }

    // Push merged result to remote
    await _pushStagingRowsToRemote();
    await _pushCookie(_getDeviceUuid());

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  /// Refesh the ledger on an ownership handoff (fresh claim), before staging
  /// reconcile. ADR-030: gated on the ledger-pull delegate being wired.
  ///
  /// Uses the block-count freshness detector so an unchanged remote chain is
  /// never re-downloaded; when the remote has grown, [LedgerPullService.pullAll]
  /// imports and seeds the missing blocks. Best-effort: any ledger failure is
  /// swallowed so a handoff still reconciles staging (fail-safe — local staging
  /// rows are never deleted on unverified ledger info).
  Future<void> _reconcileLedgerOnHandoff() async {
    final pull = ledgerPull;
    if (pull == null) return;
    try {
      final localCount = ledgerEngine?.getBlockCount() ?? 0;
      final freshness =
          await pull.pullIfRemoteHasMore(localBlockCount: localCount);
      if (freshness.success && freshness.blocksPulled > 0) {
        await pull.pullAll();
      }
    } catch (_) {
      // Best-effort: a ledger refresh failure never breaks the handoff.
    }
  }

  /// Row-level fast path: compare hash indexes, push if identical,
  /// fall through to full reconcile if different.
  Future<void> _fastPathRowLevel() async {
    try {
      // Pull remote hash index
      final remoteHashBytes = await transport!.pull(
        StagingPaths.remoteStagingHashIndex,
      );
      List<Map<String, dynamic>> remoteIndex = [];
      if (remoteHashBytes != null) {
        try {
          final decoded = json.decode(utf8.decode(remoteHashBytes));
          if (decoded is List) {
            remoteIndex = (decoded)
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList();
          }
        } catch (_) {}
      }

      // Build local hash index
      final localIndex = await StagingHashIndex.build(stagingStore);

      // Compare
      final diff = StagingHashIndex.compare(localIndex, remoteIndex);

      if (diff.identical) {
        // Fast path: identical → push current state, no merge needed
        await _pushStagingRowsToRemote();
        return;
      }

      // Hash differs → fall through to full reconcile
      await _reconcileAndClaimRowLevel();
    } catch (_) {
      // Network error on hash index → fall through to full sync
      await _reconcileAndClaimRowLevel();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // Task actions by entry_id (multi-active support)
  // ═════════════════════════════════════════════════════════════

  Future<void> endByEntryId(String entryId, int endEpoch) async {
    await end(entryId, endEpoch);
  }

  Future<void> pauseByEntryId(String entryId, int pauseEpoch) async {
    await pause(entryId, pauseEpoch);
  }

  Future<void> unpauseByEntryId(String entryId, int unpauseEpoch) async {
    await unpause(entryId, unpauseEpoch);
  }

  // ═════════════════════════════════════════════════════════════
  // Push Operations
  // ═════════════════════════════════════════════════════════════

  Future<void> pushToRemote() async {
    if (transport == null) return;

    await _pushStagingRowsToRemote();
    await _pushCookie(_getDeviceUuid());
  }

  // ═════════════════════════════════════════════════════════════
  // Debounced auto-push (row-level staging overhaul)
  // ═════════════════════════════════════════════════════════════

  static const Duration _debounceWindow = Duration(milliseconds: 500);

  /// Schedule a debounced push after a mutation.
  void _schedulePush() {
    _debounceTimer?.cancel();
    // Emit pending state immediately so UI reacts within 200ms (G10)
    if (!_isSyncing) {
      _syncStatusController.add(SyncingStatus.pendingPush);
    }
    _debounceTimer = Timer(_debounceWindow, () => _doPush());
  }

  /// Run one bidirectional auto-sync and report whether it settled cleanly.
  ///
  /// Routes through {@link checkAndSync} with [SyncCheckResult] mapped to a
  /// bool: `ready`→true, `reauthNeeded`→true (silent, AS2),
  /// `offline`/`genesisMismatch`→false. Any thrown error is swallowed and
  /// reported as false so a background auto-push never escapes an unhandled
  /// exception (e.g. a dangling debounce firing after a DB is closed).
  ///
  /// [skipReadOnlyFastPath] is always set: a mutation just occurred, so even
  /// if the local store has no pending uncommitted rows (e.g. after
  /// remove()/commit()), the remote must still be reconciled — the F1 fast
  /// path would otherwise short-circuit and skip pulling the remote's stale
  /// data.
  Future<bool> _runAutoSync() async {
    try {
      final result = await checkAndSync(skipReadOnlyFastPath: true);
      return switch (result) {
        SyncCheckResult.ready => true,
        SyncCheckResult.reauthNeeded => true,
        SyncCheckResult.offline => false,
        SyncCheckResult.genesisMismatch => false,
      };
    } catch (_) {
      return false;
    }
  }

  /// Settle a no-op auto-sync back to [SyncingStatus.inSync] so the status
  /// stream isn't left stuck on `pendingPush` (AS3).
  ///
  /// Used for the no-transport (D15) local-only path and the pre-auth (D14)
  /// guard: neither performs network work, so they should not report an
  /// error, but they must not strand the UI on `pendingPush` either.
  void _settleToInSync() {
    _syncStatusController.add(SyncingStatus.inSync);
  }

  /// Run auto-sync with a single automatic retry on the first failure (G8).
  ///
  /// Returns true if either attempt settled cleanly. Extracted so the debounce
  /// handler ([_doPush]) owns the status lifecycle and this helper owns only
  /// the retry policy.
  Future<bool> _runAutoSyncWithRetry() async {
    if (await _runAutoSync()) return true;
    return _runAutoSync(); // single retry per G8
  }

  /// Execute the debounced auto-sync (bidirectional pull + merge + push).
  ///
  /// Guards transport (D15) and pre-auth (D14) first, then runs the
  /// bidirectional reconcile with one retry, always settling the status to a
  /// terminal state and clearing [_isSyncing] via `finally`.
  Future<void> _doPush() async {
    if (transport == null) {
      _settleToInSync(); // D15 local-only (AS3)
      return;
    }
    if (!crypto.hasMasterKey) {
      _settleToInSync(); // D14 pre-auth — not an error, just nothing to sync
      return;
    }

    _isSyncing = true;
    _syncStatusController.add(SyncingStatus.pendingPush);
    try {
      final ok = await _runAutoSyncWithRetry();
      _syncStatusController.add(
        ok ? SyncingStatus.inSync : SyncingStatus.error,
      );
    } finally {
      _isSyncing = false;
    }
  }

  /// Push current staging rows to remote as an obfuscated blob.
  Future<void> _pushStagingRowsToRemote() async {
    if (transport == null) return;
    if (!crypto.hasMasterKey) return;

    final rows = await stagingStore.getAllRows();

    // R4: filter committed rows before push
    final activeRows = rows.where((r) => !_rowIsCommitted(r)).toList();

    final blobData = {
      'entries': activeRows,
      'device_id': _getDeviceUuid(),
      'device_proof': _makeDeviceProof(_getDeviceUuid()),
    };

    final jsonStr = json.encode(blobData);
    final blob = crypto.obfuscateBlob(jsonStr, crypto.getMasterKey()!);

    await transport!.push(StagingPaths.remoteRowLevelBlob, blob);

    // R7: push hash index after blob
    try {
      final hashIndex = await StagingHashIndex.build(stagingStore);
      final indexJson = json.encode(hashIndex);
      await transport!.push(
        StagingPaths.remoteStagingHashIndex,
        Uint8List.fromList(indexJson.codeUnits),
      );
    } catch (_) {}

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  /// Flush any pending queue items (offline → online transition).
  Future<void> flushPendingQueue() async {
    // Cancel pending debounce timer so it doesn't fire a duplicate push
    _debounceTimer?.cancel();
    _debounceTimer = null;
    await _doPush();
  }

  // ═════════════════════════════════════════════════════════════
  // Periodic drift-detection timer
  // (PERIODIC_AUTO_SYNC_TIMER_PHASE1.md)
  // ═════════════════════════════════════════════════════════════

  /// Default interval between periodic sync ticks. Kept short for drift
  /// latency while staying cheap per tick (cookie ETag + hash-index compare).
  static const Duration defaultPeriodicSyncInterval = Duration(seconds: 5);

  /// Start a recurring drift-detection timer. Each tick runs a guarded,
  /// fire-and-forget [checkAndSync] that forces `skipReadOnlyFastPath: true`
  /// so remote staging drift is detected even with no local pending writes.
  ///
  /// **Idempotent:** calling again (without [stopPeriodicSync]) restarts the
  /// single timer rather than stacking a second one (P8). A tick is skipped
  /// while [_isSyncing] is true to preserve the single-reconcile invariant
  /// (P5). The D15 (no transport) and D14 (no master key) guards already live
  /// inside [checkAndSync], making local-only / pre-auth ticks safe no-ops
  /// (P3/P4).
  void startPeriodicSync(Duration interval) {
    _periodicTimer?.cancel();
    _periodicTimer = Timer.periodic(interval, (_) => _onPeriodicTick());
  }

  /// Cancel the periodic timer so no further [checkAndSync] calls fire.
  void stopPeriodicSync() {
    _periodicTimer?.cancel();
    _periodicTimer = null;
  }

  /// One tick: skip when a mutation-driven [_doPush] is in flight, otherwise
  /// fire-and-forget a full drift check. Never touches the status stream
  /// (fire-and-forget) and never overlaps a [_doPush] (single-reconcile).
  void _onPeriodicTick() {
    if (_disposed) return; // no tick after teardown (P7)
    if (_isSyncing) return; // single-reconcile invariant (P5)
    unawaited(checkAndSync(skipReadOnlyFastPath: true));
  }

  /// Cancel pending debounce timer and cleanup. No push after dispose.
  void dispose() {
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _periodicTimer?.cancel();
    _periodicTimer = null;
    _disposed = true;
    _syncStatusController.close();
  }

  // ═════════════════════════════════════════════════════════════
  // Helpers
  // ═════════════════════════════════════════════════════════════

  /// Touch local cookie and schedule debounced push after a mutation.
  Future<void> _afterMutation() async {
    await _touchLocalCookie();
    _schedulePush();
  }

  /// Check whether a staging row is committed, checking both the row-level
  /// flag and the committed field inside the activity JSON blob.
  bool _rowIsCommitted(Map<String, dynamic> row) {
    if (row['committed'] == true) return true;
    final activity = _decodeActivityBlob(row['activity'] as String?);
    if (activity['committed'] == true) return true;
    return false;
  }

  /// Build the activity data map for new captures.
  Map<String, dynamic> _buildActivityData({
    required String title,
    required int startEpoch,
    required List<String> tags,
    String? comment,
    bool isActive = true,
    int? endEpoch,
    int duration = 0,
    Set<String> encryptFields = const {},
  }) {
    final data = <String, dynamic>{
      'title': title,
      'start_epoch': startEpoch,
      'end_epoch': endEpoch,
      'duration': duration,
      'is_active': isActive,
      'is_paused': false,
      'pauses': [],
      'tags': tags,
      'device_uuid': _getDeviceUuid(),
      'end_device_uuid': '',
    };
    if (comment != null) data['comment'] = comment;
    if (encryptFields.isNotEmpty) {
      data['has_encrypted_fields'] = true;
    }
    return data;
  }

  /// Safely decode the activity JSON blob from a staging row.
  Map<String, dynamic> _decodeActivityBlob(String? raw) {
    try {
      final d = json.decode(raw ?? '{}');
      if (d is Map<String, dynamic>) return d;
    } catch (_) {}
    return {};
  }

  Future<void> _touchLocalCookie() async {
    final localCookie = await storage.get('cookie');
    if (localCookie is Map && localCookie['device_specifier'] != null) {
      await storage.set('cookie', {
        'device_specifier': localCookie['device_specifier'],
        'creation_time': DateTime.now().millisecondsSinceEpoch,
      });
      return;
    }
    final deviceId = _getDeviceUuid();
    await _cookie.create(deviceId, storage);
  }

  String _getDeviceUuid() {
    if (_cachedDeviceUuid != null) return _cachedDeviceUuid!;
    _cachedDeviceUuid = crypto.generateUuid();
    return _cachedDeviceUuid!;
  }

  /// Row-level backward-compat: resolve an activity_id argument that may
  /// actually be a display title to the matching active staging row. The
  /// legacy API accepted a title for [end]/[pause]/[unpause]; row-level mode
  /// takes activity_ids but must keep resolving titles so old callers and
  /// legacy-compat tests keep working.
  Future<Map<String, dynamic>?> _resolveRowByTitle(String idOrTitle) async {
    final rows = await stagingStore.getAllRows();
    for (final row in rows) {
      final id = row['activity_id'] as String?;
      if (id == idOrTitle) return row;
      final act = _decodeActivityBlob(row['activity'] as String?);
      if (act['title'] == idOrTitle) return row;
    }
    return null;
  }

  String _makeDeviceProof(String deviceId) {
    return crypto.deviceProof(crypto.getMasterKey()!, deviceId);
  }

  // ═════════════════════════════════════════════════════════════
  // Commit to Ledger (T8) — row-level overhaul
  // ═════════════════════════════════════════════════════════════

  /// Commit ended staging entries to the ledger.
  ///
  /// When [selectedIds] is provided, only those activity_ids are committed.
  /// Otherwise, all entries with status="ended" are committed.
  ///
  /// Returns the hash prefix (first 10 chars of last block hash), or null
  /// if no entries to commit.
  ///
  /// [forceLocal] switches off the ADR-030 D11 MOVE: when true the new day
  /// block is sealed locally but the committed rows are marked `committed`
  /// (kept for History/Dashboard) instead of being MOVE-deleted, and no
  /// ledger auto-push happens. The [smartSync] remote-catchup path uses
  /// `forceLocal: true` then pushes the merged chain itself.
  Future<String?> commitAndSync({
    List<String>? selectedIds,
    bool forceLocal = false,
  }) async {
    // Get all ended entries
    final ended = await stagingStore.getRowsByStatus('ended');

    // Filter out already-committed entries (seeded by ledger pull service).
    // An entry is committed if it has a row-level committed flag OR the
    // activity JSON blob has committed=true.
    final uncommitted = ended.where((r) => !_rowIsCommitted(r)).toList();

    // Filter by selectedIds if provided (F2)
    List<Map<String, dynamic>> toCommit;
    if (selectedIds != null) {
      final selectedSet = selectedIds.toSet();
      toCommit = uncommitted
          .where((r) => selectedSet.contains(r['activity_id']))
          .toList();
    } else {
      toCommit = uncommitted;
    }

    // F6, F7: no-op when nothing to commit
    if (toCommit.isEmpty) return null;

    // F9: delegate to LedgerEngine
    if (ledgerEngine == null) {
      throw Exception(
        'LedgerEngine not configured — complete onboarding first',
      );
    }

    final hashPrefix = ledgerEngine!.commit(toCommit);

    // D11 / ADR-030: default (forceLocal=false) turn "Commit to Ledger" into
    // a MOVE only when the ledger-push delegate is wired: seal → auto-push the
    // new ledger block(s) to Remote → wipe the committed rows from local
    // staging. `forceLocal` (smartSync) and legacy mode (delegate null) keep
    // committed rows in staging (marked committed) for History display.
    final committedIds = toCommit
        .map((r) => r['activity_id'] as String?)
        .whereType<String>()
        .toSet();

    final moveRows = !forceLocal && ledgerPush != null && transport != null;
    if (moveRows && hashPrefix != null) {
      // Auto-push the freshly committed blocks to Remote (D11). Failure to
      // push is not fatal to the local commit — staging still reconciles via
      // the auto-sync path.
      try {
        await ledgerPush!.pushBlocks(ledgerEngine!.getAllBlocks());
      } catch (_) {}
      // Wipe committed rows from local staging (moved, not kept).
      for (final id in committedIds) {
        await stagingStore.deleteRow(id);
      }
    } else {
      // F3: mark committed rows (preserve for History display; the Sync tab
      // filters them out via the committed flag).
      await _markCommittedRows(toCommit);
    }

    // F4, F5: push remaining (uncommitted) staging to remote if configured
    if (transport != null) {
      try {
        await _pushStagingRowsToRemote();
      } catch (_) {}
    }

    return hashPrefix;
  }

  /// Mark ended staging rows committed in place (row-level flag + the
  /// `committed` field inside the activity JSON blob), preserving them for
  /// History/Dashboard display. Shared by the [commitAndSync] F3 branch and
  /// the no-engine local fallback in [smartSync].
  Future<void> _markCommittedRows(List<Map<String, dynamic>> rows) async {
    for (final row in rows) {
      row['committed'] = true;
      final act = _decodeActivityBlob(row['activity'] as String?);
      act['committed'] = true;
      row['activity'] = json.encode(act);
      await stagingStore.putRow(row, preserveUpdatedAt: true);
    }
  }

  /// Legacy alias — delegates to [commitAndSync] with no selections.
  ///
  /// Retained only for backward-compat callers; row-level commit keeps
  /// committed entries in staging (marked committed=true) for History.
  Future<String?> commitEntries() async {
    return commitAndSync();
  }

  // ═════════════════════════════════════════════════════════════
  // Smart Sync (unified Sync action) — SMART_SYNC_BUTTON_PHASE1
  // ═════════════════════════════════════════════════════════════

  /// Unified "Sync" action.
  ///
  /// Route the button through a decide-then-act flow (option (b),
  /// reconcile-then-push):
  ///   - **not configured** (no transport) or **offline** (health check
  ///     fails) → local-only commit (mark ended entries committed,
  ///     never push): [SmartSyncOutcome.committedLocal] (or
  ///     [SmartSyncOutcome.nothingToCommit] when empty).
  ///   - **configured + online** → pull the remote ledger blocks, merge any
  ///     missing sealed blocks into the local chain (`reconcileRemoteLedger`,
  ///     preserving the local unsealed tail), commit ended entries in place,
  ///     then push the merged chain to Remote. Reports remoteSynced when
  ///     something changed, remoteDry when already in sync, pushFailed when
  ///     R2 cannot be reached.
  Future<SmartSyncOutcome> smartSync({List<String>? selectedIds}) async {
    final engine = ledgerEngine;

    // No ledger engine → none of the remote reconcile/push work is possible,
    // so the only path is a local-only mark of ended rows (never crashes on
    // an unconfigured device; mirrors the unconfigured/unwired legacy flow).
    if (engine == null) {
      final marked = await _markEndedCommitted(selectedIds);
      return marked
          ? SmartSyncOutcome.committedLocal
          : SmartSyncOutcome.nothingToCommit;
    }

    // Not configured OR health check fails → local-only commit (mark ended
    // entries committed, never pull or push).
    if (transport == null || !await _isRemoteOnline()) {
      final hash = await commitAndSync(
        selectedIds: selectedIds,
        forceLocal: true,
      );
      return hash != null
          ? SmartSyncOutcome.committedLocal
          : SmartSyncOutcome.nothingToCommit;
    }

    // Configured + online.
    var changed = false;

    // 1. Pull + merge the remote ledger onto the local chain (append-only;
    // never truncates the local unsealed tail, never clobbers a fork).
    final remoteBlocks = await _readRemoteBlocks();
    if (remoteBlocks.isNotEmpty) {
      final reconcile = await reconcileRemoteLedger(remoteBlocks);
      changed = reconcile.appended > 0;
    }

    // 2. Commit ended entries in place (mark committed, keep for History;
    // the merge/push below pushes the sealed block(s)).
    final hash = await commitAndSync(
      selectedIds: selectedIds,
      forceLocal: true,
    );
    changed = changed || hash != null;

    // 3. Push the full merged chain to Remote. Always attempted on the online
    // path so a push failure (even with nothing new) surfaces as pushFailed
    // instead of a false "in sync" (A8).
    final pushSvc = ledgerPush;
    if (pushSvc != null) {
      try {
        final result = await pushSvc.pushBlocks(engine.getAllBlocks());
        if (!result.success) return SmartSyncOutcome.pushFailed;
      } catch (_) {
        return SmartSyncOutcome.pushFailed;
      }
    } else {
      // No push delegate wired: fall back to a local-only success so the UI
      // degrades instead of erroring.
      return hash != null
          ? SmartSyncOutcome.committedLocal
          : SmartSyncOutcome.nothingToCommit;
    }

    return changed
        ? SmartSyncOutcome.remoteSynced
        : SmartSyncOutcome.remoteDry;
  }

  /// Mark ended (optionally [selectedIds]) staging rows committed without a
  /// ledger engine — the no-engine local-only fallback for [smartSync].
  Future<bool> _markEndedCommitted(List<String>? selectedIds) async {
    final ended = await stagingStore.getRowsByStatus('ended');
    final uncommitted = ended.where((r) => !_rowIsCommitted(r)).toList();
    List<Map<String, dynamic>> toMark = uncommitted;
    if (selectedIds != null) {
      final set = selectedIds.toSet();
      toMark = uncommitted
          .where((r) => set.contains(r['activity_id']))
          .toList();
    }
    if (toMark.isEmpty) return false;
    await _markCommittedRows(toMark);
    return true;
  }

  /// Probe the transport health so smartSync can decide online vs offline.
  Future<bool> _isRemoteOnline() async {
    final t = transport;
    if (t == null) return false;
    try {
      await t.healthCheck();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Read the remote ledger blocks from R2 as chain maps (deobfuscated).
  ///
  /// Uses `ledger/hash_index.json` (plaintext) to discover block count, then
  /// pulls and deobfuscates each `ledger/blocks/NNNNNN.json`. Returns an empty
  /// list when there is nothing remote, no master key, or a pull/parse error
  /// (fail-safe).
  Future<List<Map<String, dynamic>>> _readRemoteBlocks() async {
    final t = transport;
    if (t == null || !crypto.hasMasterKey) return const [];
    try {
      final indexBytes = await t.pull('ledger/hash_index.json');
      if (indexBytes == null) return const [];
      final hashes = json.decode(utf8.decode(indexBytes));
      if (hashes is! List) return const [];
      final mk = crypto.getMasterKey()!;
      final blocks = <Map<String, dynamic>>[];
      for (var i = 0; i < hashes.length; i++) {
        final path = 'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
        final raw = await t.pull(path);
        if (raw == null) continue;
        final jsonStr = crypto.deobfuscateBlob(raw, mk);
        blocks.add(json.decode(jsonStr) as Map<String, dynamic>);
      }
      return blocks;
    } catch (_) {
      return const [];
    }
  }

  /// Merge a remote ledger (chain maps) onto the local chain, append-only.
  ///
  /// For each position, a remote block identical (same hash) to the local one
  /// is skipped. A remote block whose chain diverges from the local sealed
  /// chain — same index, different hash, or whose `prev_hash` does not bridge
  /// to the last local block — is **reported as a conflict and never written**, so
  /// a stale device never clobbers remote canonical blocks (D3/D4). Missing
  /// remote blocks that bridge the local tail are appended in order (D1/D2),
  /// so a behind-device catches up instead of overwriting.
  ///
  /// Returns a [ReconcileResult] listing conflicted block ordinals and the
  /// count appended.
  Future<ReconcileResult> reconcileRemoteLedger(
    List<Map<String, dynamic>> remoteBlocks,
  ) async {
    final engine = ledgerEngine;
    if (engine == null) return const ReconcileResult();
    final chain = engine.chain;

    final r = reconcileChainCore(
      local: chain.readAll(),
      remoteBlocks: remoteBlocks,
      blockHash: getBlockHash,
      genesisType: 'genesis',
      appendBlocks: chain.appendBlocks,
    );
    return ReconcileResult(
      conflictedIndices: r.conflictedIndices,
      appended: r.appended,
    );
  }
}

/// Sync status for visual indicators.
enum SyncingStatus {
  /// Remote matches local — all in sync.
  inSync,

  /// Local has mutations not yet pushed to remote.
  pendingPush,

  /// Persistent push failure — network or server error.
  error,
}

/// Outcome of a [SyncService.smartSync] call — drives the unified Sync button's
/// result reporting (SMART_SYNC_BUTTON_PHASE1).
enum SmartSyncOutcome {
  /// Configured + online: reconciled missing blocks and/or pushed the merged
  /// chain to Remote.
  remoteSynced,

  /// Committed ended entries to the local ledger only (unconfigured, offline,
  /// or no push delegate) — no remote push.
  committedLocal,

  /// Nothing to commit and nothing to reconcile.
  nothingToCommit,

  /// Configured + online but the ledger push to Remote failed.
  pushFailed,

  /// Configured + online and already in sync — no redundant push reported.
  remoteDry,
}

/// Result of a [SyncService.reconcileRemoteLedger] merge: which remote block
/// ordinals diverged from the local sealed chain (never written), and how many
/// missing blocks were appended (behind-device catch-up).
class ReconcileResult {
  /// Block ordinals where the remote chain conflicted with the local chain and
  /// was NOT written (fork / same-index-different-hash / non-bridging tip).
  final List<int> conflictedIndices;

  /// Number of missing remote blocks appended to the local chain.
  final int appended;

  const ReconcileResult({
    this.conflictedIndices = const [],
    this.appended = 0,
  });

  /// Whether the merge surfaced any divergent/cannot-merge remote block.
  bool get hasConflicts => conflictedIndices.isNotEmpty;
}
