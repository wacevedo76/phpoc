import 'dart:convert' show json;
import 'dart:typed_data';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/sync_result.dart';
import '../../core/utils/format_utils.dart';
import 'device_cookie.dart';
import 'genesis_gate.dart';
import 'local_cache.dart';
import 'merge_engine.dart';
import 'transport.dart';

/// Unified sync gate + local I/O for staging entries.
///
/// Port of web src/sync/sync.js and domain/staging/service.py.
class SyncService {
  final dynamic storage;
  final CryptoService crypto;
  HttpTransport? transport;

  final LocalCache _local;
  final DeviceCookie _cookie;
  final GenesisGate _genesisGate;

  int _lastPushAt = 0;
  String? _cachedDeviceUuid;

  SyncService({
    required this.storage,
    required this.crypto,
    this.transport,
  })  : _local = LocalCache(storage: storage, crypto: crypto),
        _cookie = DeviceCookie(),
        _genesisGate = GenesisGate();

  // ── Diagnostics ──────────────────────────────────────────────

  bool get isRemoteAvailable => transport != null;
  int get lastPushAt => _lastPushAt;

  // ═════════════════════════════════════════════════════════════
  // Local staging CRUD (no remote calls)
  // ═════════════════════════════════════════════════════════════

  /// Capture a new task. Returns the entry hash prefix.
  ///
  /// [encryptFields] controls per-field encryption for title/tags/comment.
  /// Only epoch timestamps are encrypted by default; add field names to the
  /// set to also encrypt those fields (e.g. `{'title', 'tags', 'comment'}`).
  Future<String> capture({
    required String title,
    List<String>? tags,
    String? comment,
    Set<String> encryptFields = const {},
  }) async {
    final startEpoch = DateTime.now().millisecondsSinceEpoch;
    final deviceUuid = _getDeviceUuid();
    final hash = await _local.append(
      title: title,
      startEpoch: startEpoch,
      isActive: true,
      tags: tags,
      comment: comment,
      deviceUuid: deviceUuid,
      encryptFields: encryptFields,
    );
    await _touchLocalCookie();
    return hash;
  }

  /// End a running task by title.
  /// Auto-closes any open pause before ending.
  /// Throws if no active task matches [title].
  Future<void> end(String title, int endEpoch) async {
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, title);
    final entry = entries[foundIndex];

    // Auto-unpause if currently paused
    if (entry['is_paused'] == true) {
      await _local.closePause(foundIndex, endEpoch);
    }

    final endDeviceUuid = _getDeviceUuid();
    await _local.update(foundIndex, {
      'end_epoch': endEpoch,
      'is_active': false,
      'end_device_uuid': endDeviceUuid,
    });

    // Recompute duration
    final updated = await _local.readEntries();
    final e = updated[foundIndex];
    final duration = LocalCache.computeDuration(
      e['start_epoch'],
      endEpoch,
      e['pauses'] as List,
    );
    await _local.update(foundIndex, {'duration': duration});

    await _touchLocalCookie();
  }

  /// Pause an active task by title.
  /// Throws if no active task matches [title].
  Future<void> pause(String title, int pauseEpoch) async {
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, title);
    await _local.addPause(foundIndex, pauseEpoch);
    await _touchLocalCookie();
  }

  /// Unpause (resume) a paused task by title.
  /// Throws if no active task matches [title].
  Future<void> unpause(String title, int unpauseEpoch) async {
    final entries = await _local.readEntries();
    final foundIndex = _findActiveEntryIndex(entries, title);
    await _local.closePause(foundIndex, unpauseEpoch);
    await _touchLocalCookie();
  }

  /// Modify a staged entry's fields in-place.
  ///
  /// [encryptFields] controls per-field encryption for title/tags/comment
  /// (default empty = only timestamps encrypted).
  Future<void> modify(int index, Map<String, dynamic> fields, {Set<String> encryptFields = const {}}) async {
    await _local.update(index, fields, encryptFields: encryptFields);
    await _touchLocalCookie();
  }

  /// Delete a staged entry.
  Future<void> remove(int index) async {
    await _local.delete(index);
    await _touchLocalCookie();
  }

  // ═════════════════════════════════════════════════════════════
  // Queries (no remote calls)
  // ═════════════════════════════════════════════════════════════

  /// Get the single active (running) task, or null if none.
  Future<Map<String, dynamic>?> getActive() async {
    final entries = await _local.readEntries();
    for (final entry in entries) {
      if (entry['is_active'] == true) {
        return entry;
      }
    }
    return null;
  }

  /// Get all staging entries, optionally filtered by date range.
  /// [from] is inclusive (start of day). [to] is inclusive (end of day).
  Future<List<Map<String, dynamic>>> getEntries({
    DateTime? from,
    DateTime? to,
  }) async {
    final entries = await _local.readEntries();
    if (from == null && to == null) return entries;

    return entries.where((entry) {
      final startEpoch = entry['start_epoch'] as int? ?? 0;
      final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch, isUtc: true);
      if (from != null && startDt.isBefore(from)) return false;
      if (to != null) {
        // End-of-day boundary for inclusive to-date matching
        final toEndOfDay = DateTime.utc(to.year, to.month, to.day, 23, 59, 59, 999);
        if (startDt.isAfter(toEndOfDay)) return false;
      }
      return true;
    }).toList();
  }

  /// Get completed (is_active==false) entries with normalized date field,
  /// sorted by start_epoch descending.
  Future<List<Map<String, dynamic>>> getCompleted() async {
    final entries = await _local.readEntries();
    final completed = entries.where((e) => e['is_active'] != true).map((e) {
      final startEpoch = e['start_epoch'] as int?;
      // start_epoch==0 means missing/unknown — use "unknown"
      final dateStr = (startEpoch != null && startEpoch > 0)
          ? FormatUtils.epochToDateStr(startEpoch)
          : 'unknown';
      return {
        ...e,
        'date': dateStr,
      };
    }).toList();

    // Sort by start_epoch descending (most recent first)
    completed.sort((a, b) {
      final aEpoch = a['start_epoch'] as int? ?? 0;
      final bEpoch = b['start_epoch'] as int? ?? 0;
      return bEpoch.compareTo(aEpoch);
    });

    return completed;
  }

  // ═════════════════════════════════════════════════════════════
  // Sync Gate
  // ═════════════════════════════════════════════════════════════

  /// Check remote sync status and reconcile if possible.
  Future<SyncCheckResult> checkAndSync() async {
    // No transport → local-only mode
    if (transport == null) return SyncCheckResult.ready;

    // Genesis gate passthrough (MVP: no local ledger blocks)
    try {
      final genesisResult = await _genesisGate.check();
      if (genesisResult != null) {
        return SyncCheckResult.genesisMismatch;
      }
    } catch (_) {
      return SyncCheckResult.offline;
    }

    // Check if master key is available
    if (!crypto.hasMasterKey) {
      return SyncCheckResult.reauthNeeded;
    }

    // Fast path: local cookie valid?
    final localCookie = await _cookie.isValidLocally(storage, ttlMinutes: 30);

    if (localCookie != null) {
      // Pull remote cookie and compare
      try {
        final remoteCookieBytes = await transport!.pull('device_cookie.bin');
        final remoteCookie = _cookie.parseRemote(remoteCookieBytes);

        if (remoteCookie != null) {
          if (_cookie.matches(localCookie, remoteCookie)) {
            // Same device → fast path: push local blob only
            await _pushBlobOnly();
            return SyncCheckResult.ready;
          } else {
            // Different device → clear stale local cookie, re-auth needed
            await _cookie.destroyLocally(storage);
            return SyncCheckResult.reauthNeeded;
          }
        }
        // No remote cookie → fall through to reconcile (first push wins)
      } catch (_) {
        // Network error during cookie pull → offline
        return SyncCheckResult.offline;
      }
    }

    // No valid local cookie (first sync or expired) + MK available → reconcile.
    // This creates a cookie and pushes the merged staging blob.
    try {
      await _reconcileAndClaim();
      return SyncCheckResult.ready;
    } catch (_) {
      return SyncCheckResult.offline;
    }
  }

  /// Perform initial sync pull during restore-from-cloud.
  ///
  /// Pulls the remote staging blob, deobfuscates it, merges with local
  /// entries, creates a device cookie, and pushes the result.
  /// Used by [OnboardingService.restoreFromCloud].
  Future<void> initialPull() async {
    await _reconcileAndClaim();
  }

  /// Pull and deobfuscate remote staging blob.
  /// Returns list of entry maps, or empty list on any failure.
  Future<List<Map<String, dynamic>>> _pullRemoteBlob() async {
    try {
      final blob = await transport!.pull('staging/blob.bin');
      if (blob == null || !crypto.hasMasterKey) return [];

      final jsonStr = crypto.deobfuscateBlob(
        blob,
        crypto.getMasterKey()!,
      );
      final decoded = _safeJsonDecode(jsonStr);
      if (decoded != null && decoded['entries'] is List) {
        return (decoded['entries'] as List)
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList();
      }
    } catch (_) {
      // Blob pull failed — use empty remote
    }
    return [];
  }

  /// Push device cookie to remote transport, if a cookie exists.
  Future<void> _pushCookie(String deviceId) async {
    final cookie = await _cookie.create(deviceId, storage);
    if (cookie != null) {
      final cookieJson = json.encode(cookie);
      await transport!.push(
        'device_cookie.bin',
        Uint8List.fromList(cookieJson.codeUnits),
      );
    }
  }

  /// Reconcile: pull remote blob, merge with local, push merged result.
  Future<void> _reconcileAndClaim() async {
    if (transport == null) return;

    final remoteEntries = await _pullRemoteBlob();
    final localEntries = await _local.readEntries();

    // Filter out committed entries
    final activeLocal =
        localEntries.where((e) => e['committed'] != true).toList();
    final activeRemote =
        remoteEntries.where((e) => e['committed'] != true).toList();

    // Merge and write
    await _local.writeEntries(
      MergeEngine.mergeMaps(activeLocal, activeRemote),
    );

    // Push blob + cookie
    await _pushBlobOnly();
    await _pushCookie(_getDeviceUuid());

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  // ═════════════════════════════════════════════════════════════
  // Push Operations
  // ═════════════════════════════════════════════════════════════

  /// Push local staging blob to remote transport.
  /// Blob before cookie (crash safety). Includes hash index (best-effort).
  Future<void> pushToRemote() async {
    if (transport == null) return;

    // Blob BEFORE cookie (crash safety)
    await _pushBlobOnly();

    // Cookie second
    await _pushCookie(_getDeviceUuid());

    // Staging hash index (best-effort)
    try {
      final hashIndex = await _local.readHashIndex();
      if (hashIndex.isNotEmpty) {
        final indexJson = json.encode(hashIndex);
        await transport!.push(
          'staging_hash_index.json',
          Uint8List.fromList(indexJson.codeUnits),
        );
      }
    } catch (_) {}
  }

  /// Push blob only (no cookie touch). Used in fast path.
  Future<void> _pushBlobOnly() async {
    final blobBytes = await _buildBlobBytes();
    if (blobBytes == null) return;

    await transport!.push('staging/blob.bin', blobBytes);
    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  // ═════════════════════════════════════════════════════════════
  // Helpers
  // ═════════════════════════════════════════════════════════════

  /// Touch local cookie TTL (extend on every write).
  Future<void> _touchLocalCookie() async {
    final localCookie = await storage.get('cookie');
    if (localCookie is Map && localCookie['device_specifier'] != null) {
      // Cookie exists — refresh TTL
      await storage.set('cookie', {
        'device_specifier': localCookie['device_specifier'],
        'creation_time': DateTime.now().millisecondsSinceEpoch,
      });
      return;
    }

    // No cookie exists yet — create one
    final deviceId = _getDeviceUuid();
    await _cookie.create(deviceId, storage);
  }

  String _getDeviceUuid() {
    if (_cachedDeviceUuid != null) return _cachedDeviceUuid!;
    _cachedDeviceUuid = crypto.generateUuid();
    return _cachedDeviceUuid!;
  }

  /// Find index of an active entry by title. Throws if not found.
  int _findActiveEntryIndex(List<Map<String, dynamic>> entries, String title) {
    final idx = entries.indexWhere(
      (e) => e['title'] == title && e['is_active'] == true,
    );
    if (idx == -1) {
      throw Exception('No active task found for: $title');
    }
    return idx;
  }

  /// Serialize local entries to an obfuscated blob payload.
  /// Returns null when transport is missing (local-only mode).
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

  static Map<String, dynamic>? _safeJsonDecode(String str) {
    try {
      final d = json.decode(str);
      if (d is Map<String, dynamic>) return d;
      return null;
    } catch (_) {
      return null;
    }
  }
}
