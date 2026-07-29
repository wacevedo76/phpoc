import 'dart:async';
import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/sync_result.dart';
import '../../core/utils/format_utils.dart';
import '../ledger/engine.dart';
import 'activity_id.dart';
import 'device_cookie.dart';
import 'staging_paths.dart';
import 'genesis_gate.dart';
import 'local_cache.dart';
import 'merge_engine.dart';
import 'staging_hash_index.dart';
import 'staging_store.dart';
import 'transport.dart';

/// Unified sync gate + local I/O for staging entries.
///
/// Port of web src/sync/sync.js and domain/staging/service.py.
///
/// Row-level staging overhaul: [stagingStore] replaces the monolithic
/// `entries` JSON-array blob. When provided, mutation wrappers use
/// activity_id-based row operations with debounced auto-push to R2.
///
/// Backward-compatible: when [stagingStore] is null, falls back to
/// [LocalCache]-based blob storage.
class SyncService {
  final dynamic storage;
  final CryptoService crypto;
  HttpTransport? transport;
  StagingStore? stagingStore;

  final LocalCache _local;
  final DeviceCookie _cookie;
  final GenesisGate _genesisGate;
  LedgerEngine? ledgerEngine;

  int _lastPushAt = 0;
  String? _cachedDeviceUuid;

  // ── Debounce + status (row-level overhaul) ──────────────────

  Timer? _debounceTimer;
  bool _isSyncing = false;
  final _syncStatusController = StreamController<SyncingStatus>.broadcast();

  SyncService({
    required this.storage,
    required this.crypto,
    this.transport,
    this.stagingStore,
    this.ledgerEngine,
  })  : _local = LocalCache(storage: storage, crypto: crypto),
        _cookie = DeviceCookie(),
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

  // ═════════════════════════════════════════════════════════════
  // Row-level mutation wrappers (new stagingStore path)
  // ═════════════════════════════════════════════════════════════

  /// Capture a new task. Returns the activity_id.
  ///
  /// When [stagingStore] is available: generates an activity_id, writes a
  /// row with status="active", and schedules a debounced push to R2.
  /// Falls back to [LocalCache.append] when [stagingStore] is null.
  Future<String> capture({
    required String title,
    List<String>? tags,
    String? comment,
    Set<String> encryptFields = const {},
    int? startEpoch,
    bool isOneOff = false,
  }) async {
    if (stagingStore != null) {
      final activityId = ActivityIdGenerator.generateActivityId();
      final resolvedEpoch =
          startEpoch ?? DateTime.now().millisecondsSinceEpoch;

      final activityData = _buildActivityData(
        title: title,
        startEpoch: resolvedEpoch,
        tags: tags ?? [],
        comment: comment,
        isActive: !isOneOff,
        endEpoch: isOneOff ? resolvedEpoch + 1000 : null,
        duration: isOneOff ? 1000 : 0,
      );

      await stagingStore!.putRow({
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
      });

      await _touchLocalCookie();
      _schedulePush();
      return activityId;
    }

    // Fallback: old LocalCache path
    final resolvedEpoch = startEpoch ?? DateTime.now().millisecondsSinceEpoch;
    final deviceUuid = _getDeviceUuid();
    final hash = await _local.append(
      title: title,
      startEpoch: resolvedEpoch,
      isActive: true,
      tags: tags,
      comment: comment,
      deviceUuid: deviceUuid,
      encryptFields: encryptFields,
    );
    await _touchLocalCookie();
    return hash;
  }

  /// End a task by activity_id.
  Future<void> end(String activityId, int endEpoch) async {
    if (stagingStore != null) {
      final row = await stagingStore!.getRow(activityId);
      if (row == null) return;

      final activityData = _decodeActivityBlob(row['activity'] as String?);
      activityData['end_epoch'] = endEpoch;
      activityData['is_active'] = false;
      activityData['end_device_uuid'] = _getDeviceUuid();
      final startEpoch = activityData['start_epoch'] as int? ?? 0;
      final pauses = (activityData['pauses'] as List?) ?? [];
      final duration = LocalCache.computeDuration(startEpoch, endEpoch, pauses);
      activityData['duration'] = duration;

      row['activity_status'] = 'ended';
      row['activity'] = json.encode(activityData);
      row['end_epoch'] = endEpoch;
      row['duration'] = duration;

      await stagingStore!.putRow(row);
      await _touchLocalCookie();
      _schedulePush();
      return;
    }

    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, activityId);
    await endByEntryId(entries[foundIndex]['entry_id'] as String, endEpoch);
  }

  /// Pause a task by activity_id.
  Future<void> pause(String activityId, int pauseEpoch) async {
    if (stagingStore != null) {
      final row = await stagingStore!.getRow(activityId);
      if (row == null) return;

      final activityData = _decodeActivityBlob(row['activity'] as String?);
      final pauses = List<Map<String, dynamic>>.from(
        (activityData['pauses'] as List?) ?? [],
      );
      pauses.add({'pause_start': pauseEpoch, 'pause_stop': null});
      activityData['pauses'] = pauses;
      activityData['is_paused'] = true;

      row['activity_status'] = 'paused';
      row['activity'] = json.encode(activityData);
      row['pauses'] = pauses;

      await stagingStore!.putRow(row);
      await _touchLocalCookie();
      _schedulePush();
      return;
    }

    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, activityId);
    await pauseByEntryId(entries[foundIndex]['entry_id'] as String, pauseEpoch);
  }

  /// Unpause a task by activity_id.
  Future<void> unpause(String activityId, int unpauseEpoch) async {
    if (stagingStore != null) {
      final row = await stagingStore!.getRow(activityId);
      if (row == null) return;

      final activityData = _decodeActivityBlob(row['activity'] as String?);
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

      row['activity_status'] = 'active';
      row['activity'] = json.encode(activityData);
      row['pauses'] = pauses;

      await stagingStore!.putRow(row);
      await _touchLocalCookie();
      _schedulePush();
      return;
    }

    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, activityId);
    await unpauseByEntryId(
        entries[foundIndex]['entry_id'] as String, unpauseEpoch);
  }

  /// Modify a staged entry's fields.
  ///
  /// When [activityIdOrIndex] is [int], maps to legacy index-based modify
  /// (adapter for K4). When [String], uses as activity_id directly.
  Future<void> modify(dynamic activityIdOrIndex, Map<String, dynamic> fields,
      {Set<String> encryptFields = const {}}) async {
    if (stagingStore != null && activityIdOrIndex is String) {
      final row = await stagingStore!.getRow(activityIdOrIndex);
      if (row == null) return;

      final activityData = _decodeActivityBlob(row['activity'] as String?);

      // Merge fields into activity data
      for (final key in fields.keys) {
        activityData[key] = fields[key];
      }

      row['activity'] = json.encode(activityData);
      // Also update top-level fields for LedgerEngine.commit
      for (final key in fields.keys) {
        row[key] = fields[key];
      }

      await stagingStore!.putRow(row);
      await _touchLocalCookie();
      _schedulePush();
      return;
    }

    if (stagingStore != null && activityIdOrIndex is int) {
      // K4: index-based adapter → map to activity_id
      final all = await stagingStore!.getAllRows();
      final index = activityIdOrIndex as int;
      if (index < 0 || index >= all.length) return;
      final activityId = all[index]['activity_id'] as String;
      await modify(activityId, fields, encryptFields: encryptFields);
      return;
    }

    // Fallback: old index-based path
    if (activityIdOrIndex is int) {
      await _local.update(activityIdOrIndex, fields,
          encryptFields: encryptFields);
      await _touchLocalCookie();
    }
  }

  /// Remove a staged entry by activity_id (or index for legacy compat).
  Future<void> remove(dynamic activityIdOrIndex) async {
    if (stagingStore != null && activityIdOrIndex is String) {
      await stagingStore!.deleteRow(activityIdOrIndex);
      await _touchLocalCookie();
      _schedulePush();
      return;
    }

    // Fallback: old index-based path
    if (activityIdOrIndex is int) {
      await _local.delete(activityIdOrIndex);
      await _touchLocalCookie();
      return;
    }

    // Try parsing as int for string index
    if (activityIdOrIndex is String) {
      final idx = int.tryParse(activityIdOrIndex);
      if (idx != null) {
        await _local.delete(idx);
        await _touchLocalCookie();
      }
    }
  }

  // ═════════════════════════════════════════════════════════════
  // Queries (legacy compat — K1, K2, K3)
  // ═════════════════════════════════════════════════════════════

  /// Read all staging entries as flat DTO list (K1).
  Future<List<Map<String, dynamic>>> readEntries() async {
    if (stagingStore != null) {
      final rows = await stagingStore!.getAllRows();
      return rows.map(_stagingRowToDto).toList();
    }
    return _local.readEntries();
  }

  /// Get active entries (status="active") — K2.
  Future<List<Map<String, dynamic>>> getActive() async {
    if (stagingStore != null) {
      final rows = await stagingStore!.getRowsByStatus('active');
      return rows.map(_stagingRowToDto).toList();
    }
    final entries = await _local.readEntries();
    return entries.where((e) => e['is_active'] == true).toList();
  }

  /// Get all staging entries, optionally filtered by date range.
  Future<List<Map<String, dynamic>>> getEntries({
    DateTime? from,
    DateTime? to,
  }) async {
    final dtos = stagingStore != null
        ? (await stagingStore!.getAllRows()).map(_stagingRowToDto).toList()
        : await _local.readEntries();

    if (from == null && to == null) return dtos;

    return dtos.where((entry) => _inDateRange(entry, from, to)).toList();
  }

  /// True when entry's start_epoch falls within [from]–[to] (inclusive).
  bool _inDateRange(
      Map<String, dynamic> entry, DateTime? from, DateTime? to) {
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final startDt =
        DateTime.fromMillisecondsSinceEpoch(startEpoch, isUtc: true);
    if (from != null && startDt.isBefore(from)) return false;
    if (to != null) {
      final toEndOfDay =
          DateTime.utc(to.year, to.month, to.day, 23, 59, 59, 999);
      if (startDt.isAfter(toEndOfDay)) return false;
    }
    return true;
  }

  /// Get completed entries (status="ended") with normalized date — K3.
  Future<List<Map<String, dynamic>>> getCompleted() async {
    if (stagingStore != null) {
      final rows = await stagingStore!.getRowsByStatus('ended');
      return rows.map((row) {
        final dto = _stagingRowToDto(row);
        final startEpoch = dto['start_epoch'] as int?;
        final dateStr = (startEpoch != null && startEpoch > 0)
            ? FormatUtils.epochToDateStr(startEpoch)
            : 'unknown';
        dto['date'] = dateStr;
        return dto;
      }).toList()
        ..sort((a, b) {
          final aEpoch = a['start_epoch'] as int? ?? 0;
          final bEpoch = b['start_epoch'] as int? ?? 0;
          return bEpoch.compareTo(aEpoch);
        });
    }
    // Fallback: old LocalCache path
    final entries = await _local.readEntries();
    final completed = entries.where((e) => e['is_active'] != true).map((e) {
      final startEpoch = e['start_epoch'] as int?;
      final dateStr = (startEpoch != null && startEpoch > 0)
          ? FormatUtils.epochToDateStr(startEpoch)
          : 'unknown';
      return {
        ...e,
        'date': dateStr,
      };
    }).toList();
    completed.sort((a, b) {
      final aEpoch = a['start_epoch'] as int? ?? 0;
      final bEpoch = b['start_epoch'] as int? ?? 0;
      return bEpoch.compareTo(aEpoch);
    });
    return completed;
  }

  /// Convert a staging row to a flat DTO compatible with old consumers.
  Map<String, dynamic> _stagingRowToDto(Map<String, dynamic> row) {
    final activityData = _decodeActivityBlob(row['activity'] as String?);
    return {
      'activity_id': row['activity_id'],
      'title': activityData['title'] ?? row['title'] ?? '',
      'start_epoch': activityData['start_epoch'] ?? row['start_epoch'] ?? 0,
      'end_epoch': activityData['end_epoch'] ?? row['end_epoch'],
      'duration': activityData['duration'] ?? row['duration'] ?? 0,
      'is_active': activityData['is_active'] ?? true,
      'is_paused': activityData['is_paused'] ?? false,
      'pauses': activityData['pauses'] ?? row['pauses'] ?? [],
      'tags': activityData['tags'] ?? row['tags'] ?? [],
      'device_uuid': activityData['device_uuid'] ?? '',
      'activity_status': row['activity_status'],
      'updated_at': row['updated_at'],
    };
  }

  // ═════════════════════════════════════════════════════════════
  // Sync Gate
  // ═════════════════════════════════════════════════════════════

  Future<SyncCheckResult> checkAndSync({int cookieTtlMinutes = 30}) async {
    if (transport == null) return SyncCheckResult.ready;

    try {
      final genesisResult = await _genesisGate.check();
      if (genesisResult != null) return SyncCheckResult.genesisMismatch;
    } catch (_) {
      return SyncCheckResult.offline;
    }

    if (!crypto.hasMasterKey) return SyncCheckResult.reauthNeeded;

    final localCookie =
        await _cookie.isValidLocally(storage, ttlMinutes: cookieTtlMinutes);

    if (localCookie != null) {
      try {
        final remoteCookieBytes =
            await transport!.pull(StagingPaths.remoteDeviceCookie);
        final remoteCookie = _cookie.parseRemote(remoteCookieBytes);

        if (remoteCookie != null) {
          if (_cookie.matches(localCookie, remoteCookie)) {
            // Cookie match → fast path
            if (stagingStore != null) {
              await _fastPathRowLevel();
            } else {
              await _pushBlobOnly();
            }
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

    try {
      await _reconcileAndClaim();
      return SyncCheckResult.ready;
    } catch (_) {
      return SyncCheckResult.offline;
    }
  }

  Future<void> initialPull() async {
    await _reconcileAndClaim();
  }

  /// Pull remote staging entries from the appropriate blob path.
  ///
  /// When [stagingStore] is available, pulls from the row-level blob path
  /// ([StagingPaths.remoteRowLevelBlob]). Otherwise falls back to the legacy
  /// monolithic blob path ([StagingPaths.remoteStagingBlob]).
  Future<List<Map<String, dynamic>>> _pullRemoteBlob() async {
    final path = stagingStore != null
        ? StagingPaths.remoteRowLevelBlob
        : StagingPaths.remoteStagingBlob;

    try {
      final blob = await transport!.pull(path);
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
    final cookie = await _cookie.create(deviceId, storage);
    if (cookie != null) {
      final cookieJson = json.encode(cookie);
      await transport!.push(
        StagingPaths.remoteDeviceCookie,
        Uint8List.fromList(cookieJson.codeUnits),
      );
    }
  }

  Future<void> _reconcileAndClaim() async {
    if (transport == null) return;

    // Row-level staging: use StagingStore + MergeEngine.mergeEntries()
    if (stagingStore != null) {
      await _reconcileAndClaimRowLevel();
      return;
    }

    // Legacy: use LocalCache + mergeMaps()
    final remoteEntries = await _pullRemoteBlob();
    final localEntries = await _local.readEntries();

    final activeLocal =
        localEntries.where((e) => e['committed'] != true).toList();
    final activeRemote =
        remoteEntries.where((e) => e['committed'] != true).toList();

    await _local.writeEntries(
      MergeEngine.mergeMaps(activeLocal, activeRemote),
    );

    await _pushBlobOnly();
    await _pushCookie(_getDeviceUuid());

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  /// Row-level reconcile: pull staging/blob, merge with mergeEntries(),
  /// write to StagingStore, push via _pushStagingRowsToRemote().
  Future<void> _reconcileAndClaimRowLevel() async {
    final remoteRows = await _pullRemoteBlob();
    final localRows = await stagingStore!.getAllRows();

    // Merge: uses activity_id LWW
    final merged = MergeEngine.mergeEntries(localRows, remoteRows);

    // Build set of merged activity_ids for cleanup
    final mergedIds = merged
        .map((r) => r['activity_id'] as String)
        .where((id) => id.isNotEmpty)
        .toSet();

    // Write merged rows to StagingStore, preserving updated_at (LWW tiebreaker).
    // Delete rows that were committed remotely (committed=true in merged result).
    for (final row in merged) {
      final committed = row['committed'] as bool? ?? false;
      if (committed) {
        // Committed on another device → remove from local staging (S5 cleanup)
        await stagingStore!.deleteRow(row['activity_id'] as String);
      } else {
        await stagingStore!.putRow(row, preserveUpdatedAt: true);
      }
    }

    // Remove local-only rows that were filtered out by mergeEntries
    // (committed local-only entries, S5)
    for (final localRow in localRows) {
      final id = localRow['activity_id'] as String?;
      if (id != null && !mergedIds.contains(id)) {
        await stagingStore!.deleteRow(id);
      }
    }

    // Push merged result to remote
    await _pushStagingRowsToRemote();
    await _pushCookie(_getDeviceUuid());

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  /// Row-level fast path: compare hash indexes, push if identical,
  /// fall through to full reconcile if different.
  Future<void> _fastPathRowLevel() async {
    try {
      // Pull remote hash index
      final remoteHashBytes =
          await transport!.pull(StagingPaths.remoteStagingHashIndex);
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
      final localIndex = await StagingHashIndex.build(stagingStore!);

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
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndexById(entries, entryId);
    final entry = entries[foundIndex];

    if (entry['is_paused'] == true) {
      await _local.closePause(foundIndex, endEpoch);
    }

    final endDeviceUuid = _getDeviceUuid();
    await _local.update(foundIndex, {
      'end_epoch': endEpoch,
      'is_active': false,
      'end_device_uuid': endDeviceUuid,
    });

    final updated = await _local.readEntries();
    final e = updated[foundIndex];
    final duration = LocalCache.computeDuration(
      e['start_epoch'], endEpoch, e['pauses'] as List,
    );
    await _local.update(foundIndex, {'duration': duration});
    await _touchLocalCookie();
  }

  Future<void> pauseByEntryId(String entryId, int pauseEpoch) async {
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndexById(entries, entryId);
    await _local.addPause(foundIndex, pauseEpoch);
    await _touchLocalCookie();
  }

  Future<void> unpauseByEntryId(String entryId, int unpauseEpoch) async {
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndexById(entries, entryId);
    await _local.closePause(foundIndex, unpauseEpoch);
    await _touchLocalCookie();
  }

  // ═════════════════════════════════════════════════════════════
  // Push Operations
  // ═════════════════════════════════════════════════════════════

  Future<void> pushToRemote() async {
    if (transport == null) return;
    await _pushBlobOnly();
    await _pushCookie(_getDeviceUuid());
    try {
      final hashIndex = await _local.readHashIndex();
      if (hashIndex.isNotEmpty) {
        final indexJson = json.encode(hashIndex);
        await transport!.push(
          StagingPaths.remoteStagingHashIndex,
          Uint8List.fromList(indexJson.codeUnits),
        );
      }
    } catch (_) {}
  }

  Future<void> _pushBlobOnly() async {
    final blobBytes = await _buildBlobBytes();
    if (blobBytes == null) return;

    await transport!.push(StagingPaths.remoteStagingBlob, blobBytes);
    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
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

  /// Execute the actual push with one automatic retry on failure.
  Future<void> _doPush() async {
    if (transport == null) return; // D15: local-only
    if (!crypto.hasMasterKey) return; // D14: pre-auth

    _isSyncing = true;
    _syncStatusController.add(SyncingStatus.pendingPush);

    bool ok = await _attemptPush();
    if (!ok) ok = await _attemptPush(); // single retry per G8

    _isSyncing = false;
    _syncStatusController
        .add(ok ? SyncingStatus.inSync : SyncingStatus.error);
  }

  /// Try one push; returns true on success.
  Future<bool> _attemptPush() async {
    try {
      await _pushStagingRowsToRemote();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Push current staging rows to remote as an obfuscated blob.
  Future<void> _pushStagingRowsToRemote() async {
    if (transport == null) return;
    if (!crypto.hasMasterKey) return;

    final rows = stagingStore != null
        ? await stagingStore!.getAllRows()
        : <Map<String, dynamic>>[];

    final blobData = {
      'entries': rows,
      'device_id': _getDeviceUuid(),
      'device_proof': _makeDeviceProof(_getDeviceUuid()),
    };

    final jsonStr = json.encode(blobData);
    final blob = crypto.obfuscateBlob(jsonStr, crypto.getMasterKey()!);

    await transport!.push(StagingPaths.remoteRowLevelBlob, blob);
    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  /// Flush any pending queue items (offline → online transition).
  Future<void> flushPendingQueue() async {
    // Cancel pending debounce timer so it doesn't fire a duplicate push
    _debounceTimer?.cancel();
    _debounceTimer = null;
    await _doPush();
  }

  /// Cancel pending debounce timer and cleanup. No push after dispose.
  void dispose() {
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _syncStatusController.close();
  }

  // ═════════════════════════════════════════════════════════════
  // Helpers
  // ═════════════════════════════════════════════════════════════

  /// Build the activity data map for new captures.
  Map<String, dynamic> _buildActivityData({
    required String title,
    required int startEpoch,
    required List<String> tags,
    String? comment,
    bool isActive = true,
    int? endEpoch,
    int duration = 0,
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

  int _findActiveEntryIndex(
      List<Map<String, dynamic>> entries, String title) {
    final idx = entries.indexWhere(
      (e) => e['title'] == title && e['is_active'] == true,
    );
    if (idx == -1) throw Exception('No active task found for: $title');
    return idx;
  }

  int _findActiveEntryIndexById(
      List<Map<String, dynamic>> entries, String entryId) {
    final idx = entries.indexWhere(
      (e) => e['entry_id'] == entryId && e['is_active'] == true,
    );
    if (idx == -1) throw Exception('No active task found for id: $entryId');
    return idx;
  }

  Future<Uint8List?> _buildBlobBytes() async {
    if (transport == null) return null;

    final entries = await _local.readEntries();
    final deviceId = _getDeviceUuid();

    final blobData = {
      'entries': entries,
      'device_id': deviceId,
      'device_proof': _makeDeviceProof(deviceId),
    };

    final jsonStr = json.encode(blobData);
    return crypto.obfuscateBlob(jsonStr, crypto.getMasterKey()!);
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
  Future<String?> commitAndSync({List<String>? selectedIds}) async {
    if (stagingStore != null) {
      // Get all ended entries
      final ended = await stagingStore!.getRowsByStatus('ended');

      // Filter by selectedIds if provided (F2)
      List<Map<String, dynamic>> toCommit;
      if (selectedIds != null) {
        final selectedSet = selectedIds.toSet();
        toCommit = ended.where((r) => selectedSet.contains(r['activity_id'])).toList();
      } else {
        toCommit = ended;
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

      // F3: delete committed rows from staging
      for (final row in toCommit) {
        await stagingStore!.deleteRow(row['activity_id'] as String);
      }

      // F4, F5: push to remote if configured
      if (transport != null) {
        try {
          await _pushStagingRowsToRemote();
        } catch (_) {}
      }

      return hashPrefix;
    }

    // Fallback: old commitEntries path
    return commitEntries();
  }

  /// Commit completed staging entries to the ledger (legacy — K5).
  ///
  /// Filters to entries where is_active==false and committed!=true.
  /// Delegates to [LedgerEngine.commit], marks entries committed,
  /// and returns the hash prefix. Returns null if no entries.
  Future<String?> commitEntries() async {
    if (stagingStore != null) {
      return commitAndSync();
    }

    final allEntries = await _local.readEntries();
    final toCommit = allEntries
        .where((e) => e['is_active'] != true && e['committed'] != true)
        .toList();

    if (toCommit.isEmpty) return null;

    if (ledgerEngine == null) {
      throw Exception(
        'LedgerEngine not configured — complete onboarding first',
      );
    }

    final hashPrefix = ledgerEngine!.commit(toCommit);

    final entryIds = toCommit
        .map((e) => e['entry_id'] as String?)
        .where((id) => id != null)
        .cast<String>()
        .toList();
    await _local.markCommitted(entryIds);

    return hashPrefix;
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
