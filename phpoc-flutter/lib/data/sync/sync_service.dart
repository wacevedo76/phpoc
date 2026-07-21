import 'dart:convert' show json;
import 'dart:typed_data';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/sync_result.dart';
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
  Future<String> capture({required String title}) async {
    final startEpoch = DateTime.now().millisecondsSinceEpoch;
    final deviceUuid = _getDeviceUuid();
    final hash = await _local.append(
      title: title,
      startEpoch: startEpoch,
      isActive: true,
      deviceUuid: deviceUuid,
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
  Future<void> modify(int index, Map<String, dynamic> fields) async {
    await _local.update(index, fields);
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
  Future<List<Map<String, dynamic>>> getEntries({
    DateTime? from,
    DateTime? to,
  }) async {
    final entries = await _local.readEntries();
    if (from == null && to == null) return entries;

    return entries.where((entry) {
      final startEpoch = entry['start_epoch'] as int? ?? 0;
      final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);
      if (from != null && startDt.isBefore(from)) return false;
      if (to != null && startDt.isAfter(to)) return false;
      return true;
    }).toList();
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
            // Different device → requires re-auth
            return SyncCheckResult.reauthNeeded;
          }
        }
        // No remote cookie → fall through to auth gate
      } catch (_) {
        // Network error during cookie pull → offline
        return SyncCheckResult.offline;
      }
    } else {
      // No valid local cookie → reauth needed
      return SyncCheckResult.reauthNeeded;
    }

    // Auth gate: MK available, reconcile
    try {
      await _reconcileAndClaim();
      return SyncCheckResult.ready;
    } catch (_) {
      return SyncCheckResult.offline;
    }
  }

  /// Reconcile: pull remote blob, merge with local, push merged result.
  Future<void> _reconcileAndClaim() async {
    if (transport == null) return;

    // Pull remote staging blob
    List<Map<String, dynamic>> remoteEntries = [];
    try {
      final blob = await transport!.pull('staging/blob.bin');
      if (blob != null && crypto.hasMasterKey) {
        final base64Blob = String.fromCharCodes(blob);
        final jsonStr = crypto.deobfuscateBlob(
          base64Blob,
          crypto.getMasterKey()!,
        );
        final decoded = _safeJsonDecode(jsonStr);
        if (decoded != null && decoded['entries'] is List) {
          remoteEntries = (decoded['entries'] as List)
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
        }
      }
    } catch (_) {
      // Blob pull failed — use empty remote
    }

    // Get local entries
    final localEntries = await _local.readEntries();

    // Filter out committed entries
    final activeLocal =
        localEntries.where((e) => e['committed'] != true).toList();
    final activeRemote =
        remoteEntries.where((e) => e['committed'] != true).toList();

    // Merge
    final merged = MergeEngine.mergeMaps(activeLocal, activeRemote);

    // Write merged result
    await _local.writeEntries(merged);

    // Create new device cookie and push
    final deviceId = _getDeviceUuid();
    final newRemoteCookie = await _cookie.create(deviceId, storage);

    await _pushBlobOnly();

    if (newRemoteCookie != null) {
      final cookieJson = json.encode(newRemoteCookie);
      await transport!.push(
        'device_cookie.bin',
        Uint8List.fromList(cookieJson.codeUnits),
      );
    }

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;
  }

  // ═════════════════════════════════════════════════════════════
  // Push Operations
  // ═════════════════════════════════════════════════════════════

  /// Push local staging blob to remote transport.
  /// Blob before cookie (crash safety).
  Future<void> pushToRemote() async {
    final blobBytes = await _buildBlobBytes();
    if (blobBytes == null) return;

    // Blob BEFORE cookie
    await transport!.push('staging/blob.bin', blobBytes);

    // Cookie second
    final deviceId = _getDeviceUuid();
    final remoteCookie = await _cookie.create(deviceId, storage);
    if (remoteCookie != null) {
      final cookieJson = json.encode(remoteCookie);
      await transport!.push(
        'device_cookie.bin',
        Uint8List.fromList(cookieJson.codeUnits),
      );
    }

    _lastPushAt = DateTime.now().millisecondsSinceEpoch;

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
    try {
      final localCookie = await storage.get('cookie');
      if (localCookie is Map && localCookie['device_specifier'] != null) {
        await storage.set('cookie', {
          'device_specifier': localCookie['device_specifier'],
          'creation_time': DateTime.now().millisecondsSinceEpoch,
        });
        return;
      }
    } catch (_) {}

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
    final obfuscated = crypto.obfuscateBlob(jsonStr, crypto.getMasterKey()!);
    return Uint8List.fromList(obfuscated.codeUnits);
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
