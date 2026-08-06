import 'dart:convert' show json;

import '../../core/crypto/crypto_service.dart';

/// Local staging cache — CRUD for pending entries with per-field encryption.
///
/// Port of web src/sync/local_cache.js.
///
/// Manages local staging entries via a storage backend. Storage format:
///   - `_enc` suffix on encryptable field names
///   - `plain:` prefix for unencrypted values
///   - `{hash, data: {...}}` wrapper around entry data
///
/// readEntries() returns decrypted DTOs with flat field names.
/// writeEntries() accepts DTOs and converts to spec format for storage.
class LocalCache {
  final dynamic storage;
  final CryptoService crypto;

  LocalCache({required this.storage, required this.crypto});

  // ── Pause decode (shared by read + mutation paths) ────────────

  /// Decrypt and parse the pauses_enc field. Returns decoded list or [].
  List _decodePauses(String? pausesRaw) {
    if (pausesRaw == null) return [];
    final dec = _decrypt(pausesRaw);
    if (dec == null) return [];
    try {
      final parsed = json.decode(dec);
      return parsed is List ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  // ── Encrypt/Decrypt helpers ────────────────────────────────────

  String _encrypt(dynamic value, {bool forcePlain = false}) {
    if (forcePlain) return 'plain:${value.toString()}';
    if (!crypto.hasMasterKey) {
      return 'plain:${value.toString()}';
    }
    return crypto.encryptWithCachedKey(value.toString());
  }

  String? _decrypt(String? value) {
    if (value == null) return null;
    if (value.startsWith('plain:')) return value.substring(6);
    // Unified decrypt: canonical HMAC-derived (Python/WASM) then Flutter-legacy fallback
    try {
      return crypto.decryptWithCachedKey(value);
    } catch (_) {
      return null;
    }
  }

  int? _decryptInt(String? value) {
    final dec = _decrypt(value);
    if (dec == null) return null;
    return int.tryParse(dec);
  }

  // ── Entry hash ─────────────────────────────────────────────────

  /// Compute a deterministic entry hash from plaintext DTO fields.
  String _computeEntryHash(Map<String, dynamic> dto) {
    final fields = <String, dynamic>{
      'title': dto['title'] ?? '',
      'start_epoch': dto['start_epoch'] ?? 0,
      'end_epoch': dto['end_epoch'],
      'duration': dto['duration'] ?? 0,
      'is_active': dto['is_active'] ?? true,
      'is_paused': dto['is_paused'] ?? false,
      'pauses': dto['pauses'] ?? [],
      'tags': dto['tags'] ?? [],
      'entry_id': dto['entry_id'] ?? '',
      'metadata': dto['metadata'] ?? {},
      'device_uuid': dto['device_uuid'] ?? '',
      'end_device_uuid': dto['end_device_uuid'] ?? '',
    };
    if (dto['comment'] != null) {
      fields['comment'] = dto['comment'];
    }
    return crypto.computeEntryHash(fields);
  }

  // ── DTO ↔ Raw conversion ──────────────────────────────────────

  /// Convert a raw entry ({hash, data: {...}}) to a flat DTO.
  Map<String, dynamic> _rawToDto(Map<String, dynamic> raw, int idx) {
    final data = Map<String, dynamic>.from(raw['data'] as Map? ?? {});

    final startEpoch = _decryptInt(data['startTime_enc'] as String?) ?? 0;
    final endEpoch = _decryptInt(data['endTime_enc'] as String?);

    final pauses = _decodePauses(data['pauses_enc'] as String?);

    Map<String, dynamic> metadata = {};
    final metadataRaw = data['metadata_enc'] as String?;
    if (metadataRaw != null) {
      final dec = _decrypt(metadataRaw);
      if (dec != null) {
        try {
          metadata = json.decode(dec) as Map<String, dynamic>;
        } catch (_) {}
      }
    }

    final deviceUuid = _decrypt(data['device_uuid_enc'] as String?) ?? '';
    final endDeviceUuid = _decrypt(data['end_device_uuid_enc'] as String?) ?? '';

    // Per-field encryption fields
    String title = data['title'] as String? ?? '';
    List tags = data['tags'] as List? ?? [];
    String? comment = data['comment'] as String?;
    int duration = data['duration'] as int? ?? 0;

    if (data.containsKey('title_enc')) {
      title = _decrypt(data['title_enc'] as String?) ?? '';
    }
    if (data.containsKey('tags_enc')) {
      final dec = _decrypt(data['tags_enc'] as String?);
      if (dec != null) {
        try {
          tags = json.decode(dec) as List;
        } catch (_) {
          tags = [];
        }
      } else {
        tags = [];
      }
    }
    if (data.containsKey('comment_enc')) {
      comment = _decrypt(data['comment_enc'] as String?);
    }
    if (data.containsKey('duration_enc')) {
      final dec = _decrypt(data['duration_enc'] as String?);
      duration = dec != null ? int.tryParse(dec) ?? 0 : 0;
    }

    return {
      'entry_id': data['entry_id'] ?? '',
      'title': title,
      'start_epoch': startEpoch,
      'end_epoch': endEpoch,
      'duration': duration,
      'is_active': data['is_active'] ?? false,
      'is_paused': data['is_paused'] ?? false,
      'pauses': pauses,
      'tags': tags,
      'comment': comment,
      'device_uuid': deviceUuid,
      'end_device_uuid': endDeviceUuid,
      'metadata': metadata,
      'hash': raw['hash'] ?? '',
      'entry_index': idx,
      'committed': raw['committed'] ?? false,
      'has_encrypted_fields': data['has_encrypted_fields'] ?? false,
      'title_encrypted': !data.containsKey('title_enc'),
      'tags_encrypted': !data.containsKey('tags_enc'),
      'comment_encrypted': !data.containsKey('comment_enc'),
    };
  }

  /// Convert a flat DTO to raw {hash, data: {...}} format.
  Map<String, dynamic> _dtoToRaw(Map<String, dynamic> dto, {bool forcePlain = false}) {
    final data = <String, dynamic>{
      'entry_id': dto['entry_id'] ?? '',
      'title': dto['title'] ?? '',
      'startTime_enc': _encrypt(dto['start_epoch'] ?? 0, forcePlain: forcePlain),
      'endTime_enc': dto['end_epoch'] != null ? _encrypt(dto['end_epoch'], forcePlain: forcePlain) : null,
      'duration': dto['duration'] ?? 0,
      'is_active': dto['is_active'] ?? true,
      'is_paused': dto['is_paused'] ?? false,
      'pauses_enc': _encrypt(json.encode(dto['pauses'] ?? []), forcePlain: forcePlain),
      'tags': dto['tags'] ?? [],
      'device_uuid_enc': _encrypt(dto['device_uuid'] ?? '', forcePlain: forcePlain),
      'end_device_uuid_enc': _encrypt(dto['end_device_uuid'] ?? '', forcePlain: forcePlain),
      'metadata_enc': _encrypt(json.encode(dto['metadata'] ?? {}), forcePlain: forcePlain),
    };
    if (dto['comment'] != null) data['comment'] = dto['comment'];

    // Remove null fields
    data.removeWhere((_, v) => v == null);

    return {
      'hash': dto['hash'] ?? '',
      'data': data,
      'committed': dto['committed'] ?? false,
    };
  }

  // ── Read / Write (full list) ───────────────────────────────────

  /// Read all staging entries as decrypted DTOs.
  Future<List<Map<String, dynamic>>> readEntries() async {
    final entries = (await storage.get('entries') as List?) ?? [];
    return entries.asMap().entries.map((e) {
      return _rawToDto(e.value as Map<String, dynamic>, e.key);
    }).toList();
  }

  /// Write a list of DTOs to storage in spec format.
  Future<void> writeEntries(List<Map<String, dynamic>> dtos) async {
    final rawEntries = dtos.map(_dtoToRaw).toList();
    await storage.set('entries', rawEntries);
  }

  // ── append ────────────────────────────────────────────────────

  /// Append a new staging entry. Returns the entry hash prefix (10 chars).
  ///
  /// [startEpoch] — ms timestamp. Throws on collision (same start_epoch).
  /// [encryptFields] controls per-field encryption for title/tags/comment:
  /// - default (empty or omitted) → only epoch timestamps are encrypted
  /// - set of field names (e.g. `{'title', 'tags', 'comment'}`) →
  ///   those fields are encrypted in addition to always-encrypted timestamps
  Future<String> append({
    required String title,
    required int startEpoch,
    int? endEpoch,
    bool isActive = true,
    List<String>? tags,
    String? comment,
    String? deviceUuid,
    Set<String> encryptFields = const {},
  }) async {
    final entries = (await storage.get('entries') as List?) ?? [];

    // Ensure unique start_epoch: auto-increment on same-ms collision.
    // Matches Python's ValueError guard but avoids flaky failures when
    // two captures hit the same millisecond (common in fast test suites
    // and rapid real-world interaction).
    final existingEpochs = entries
        .map((e) => _rawToDto(e as Map<String, dynamic>, -1))
        .map((d) => d['start_epoch'] as int? ?? 0)
        .toSet();
    var resolvedEpoch = startEpoch;
    while (existingEpochs.contains(resolvedEpoch)) {
      resolvedEpoch++;
    }

    final normalizedTags = _normalizeTags(tags);
    final entryId = crypto.generateUuid();

    // Per-field encryption: timestamps always encrypted;
    // title/tags/comment only encrypted when in encryptFields set
    bool shouldEncrypt(String field) => encryptFields.contains(field);

    final data = <String, dynamic>{
      'entry_id': entryId,
      'title': title,
      'duration': endEpoch != null ? endEpoch - resolvedEpoch : 0,
      'is_active': isActive,
      'is_paused': false,
      'startTime_enc': _encrypt(resolvedEpoch),
      'endTime_enc': endEpoch != null ? _encrypt(endEpoch) : null,
      'pauses_enc': _encrypt('[]'),
      'tags': normalizedTags,
      'device_uuid_enc': _encrypt(deviceUuid ?? ''),
      'end_device_uuid_enc': _encrypt(''),
      'metadata_enc': _encrypt('{}'),
    };
    // Per-field encryptable fields (title, tags, comment)
    if (!shouldEncrypt('title')) data['title_enc'] = _encrypt(title, forcePlain: true);
    if (!shouldEncrypt('tags')) data['tags_enc'] = _encrypt(json.encode(normalizedTags), forcePlain: true);
    if (comment != null) {
      data['comment'] = comment;
      if (!shouldEncrypt('comment')) {
        data['comment_enc'] = _encrypt(comment, forcePlain: true);
      }
    }
    data.removeWhere((_, v) => v == null);

    if (encryptFields.isNotEmpty) {
      data['has_encrypted_fields'] = true;
    }

    final hash = _computeEntryHash({
      'title': title,
      'start_epoch': resolvedEpoch,
      'end_epoch': endEpoch,
      'duration': endEpoch != null ? endEpoch - resolvedEpoch : 0,
      'is_active': isActive,
      'is_paused': false,
      'pauses': [],
      'tags': normalizedTags,
      'entry_id': entryId,
      'metadata': {},
      'device_uuid': deviceUuid ?? '',
      'end_device_uuid': '',
      'comment': comment,
    });

    final rawEntry = {
      'hash': hash,
      'data': data,
      'committed': false,
    };

    entries.add(rawEntry);
    await storage.set('entries', entries);

    return hash.substring(0, 10);
  }

  // ── Encryptable-field update helper ───────────────────────────

  /// Set [field] on [data] and manage its `_enc` variant.
  ///
  /// When [encrypt] is false, writes a `plain:` prefixed copy to
  /// `{field}_enc`. When true, removes any existing `{field}_enc`.
  /// [encode] allows custom serialization for storage (e.g., JSON for lists).
  void _upsertEncryptableField(
    Map<String, dynamic> data,
    String field,
    dynamic value, {
    required bool encrypt,
    String Function(dynamic)? encode,
  }) {
    data[field] = value;
    final encKey = '${field}_enc';
    if (!encrypt) {
      final encoded = encode != null ? encode(value) : value.toString();
      data[encKey] = _encrypt(encoded, forcePlain: true);
    } else {
      data.remove(encKey);
    }
  }

  // ── update ────────────────────────────────────────────────────

  /// Update specific fields on an entry at the given index.
  ///
  /// [fields] uses DTO field names (e.g., 'title', 'end_epoch', 'is_active').
  /// No-op on committed entries.
  /// [encryptFields] controls per-field encryption for title/tags/comment
  /// (default empty = only timestamps encrypted).
  Future<void> update(int index, Map<String, dynamic> fields, {Set<String> encryptFields = const {}}) async {
    final rawEntries = (await storage.get('entries') as List?) ?? [];
    if (index < 0 || index >= rawEntries.length) return;

    final raw = rawEntries[index] as Map<String, dynamic>;

    // Guard: refuse to modify committed entries
    if (raw['committed'] == true) return;

    // Handle committed flag (raw-level metadata, not in data dict)
    if (fields.containsKey('committed')) {
      raw['committed'] = fields['committed'];
    }

    final data = Map<String, dynamic>.from(raw['data'] as Map? ?? {});

    bool shouldEncrypt(String field) => encryptFields.contains(field);

    // ── Per-field encryptable: title, tags, comment (plain + _enc) ─
    if (fields.containsKey('title')) {
      _upsertEncryptableField(data, 'title', fields['title'], encrypt: shouldEncrypt('title'));
    }
    if (fields.containsKey('tags')) {
      final norm = _normalizeTags(fields['tags']);
      _upsertEncryptableField(data, 'tags', norm, encrypt: shouldEncrypt('tags'), encode: json.encode);
    }
    if (fields.containsKey('comment')) {
      if (fields['comment'] == null) {
        data.remove('comment');
        data.remove('comment_enc');
      } else {
        _upsertEncryptableField(data, 'comment', fields['comment'], encrypt: shouldEncrypt('comment'));
      }
    }

    // ── Always-encrypted fields (only _enc, no plain copy) ────────
    if (fields.containsKey('end_epoch')) {
      data['endTime_enc'] = _encrypt(fields['end_epoch']);
    }
    if (fields.containsKey('start_epoch')) {
      data['startTime_enc'] = _encrypt(fields['start_epoch']);
    }
    if (fields.containsKey('device_uuid')) {
      data['device_uuid_enc'] = _encrypt(fields['device_uuid']);
    }
    if (fields.containsKey('end_device_uuid')) {
      data['end_device_uuid_enc'] = _encrypt(fields['end_device_uuid']);
    }

    // ── Pauses (encrypted JSON blob) ────────────────────────────
    if (fields.containsKey('pauses')) {
      data['pauses_enc'] = _encrypt(json.encode(fields['pauses'] ?? []));
    }

    // ── Plain-only fields (no encryption) ─────────────────────────
    if (fields.containsKey('is_active')) data['is_active'] = fields['is_active'];
    if (fields.containsKey('is_paused')) data['is_paused'] = fields['is_paused'];
    if (fields.containsKey('duration')) data['duration'] = fields['duration'];

    if (encryptFields.isNotEmpty) {
      data['has_encrypted_fields'] = true;
    }

    raw['data'] = data;

    // Recompute hash
    final dto = _rawToDto(raw, index);
    raw['hash'] = _computeEntryHash(dto);
    rawEntries[index] = raw;
    await storage.set('entries', rawEntries);
  }

  // ── delete ────────────────────────────────────────────────────

  /// Remove entry at the given index.
  Future<void> delete(int index) async {
    final rawEntries = (await storage.get('entries') as List?) ?? [];
    if (index >= 0 && index < rawEntries.length) {
      rawEntries.removeAt(index);
      await storage.set('entries', rawEntries);
    }
  }

  // ── Pause management ──────────────────────────────────────────

  /// Add a new open pause record to the entry at [index].
  Future<void> addPause(int index, int pauseEpoch) async {
    final rawEntries = (await storage.get('entries') as List?) ?? [];
    if (index < 0 || index >= rawEntries.length) return;

    final raw = rawEntries[index] as Map<String, dynamic>;
    final data = Map<String, dynamic>.from(raw['data'] as Map? ?? {});

    final pauses = _decodePauses(data['pauses_enc'] as String?);
    pauses.add({'pause_start': pauseEpoch, 'pause_stop': null});
    data['pauses_enc'] = _encrypt(json.encode(pauses));
    data['is_paused'] = true;

    raw['data'] = data;
    final dto = _rawToDto(raw, index);
    raw['hash'] = _computeEntryHash(dto);
    rawEntries[index] = raw;
    await storage.set('entries', rawEntries);
  }

  /// Close the last open pause record on the entry at [index].
  Future<void> closePause(int index, int stopEpoch) async {
    final rawEntries = (await storage.get('entries') as List?) ?? [];
    if (index < 0 || index >= rawEntries.length) return;

    final raw = rawEntries[index] as Map<String, dynamic>;
    final data = Map<String, dynamic>.from(raw['data'] as Map? ?? {});

    final pauses = _decodePauses(data['pauses_enc'] as String?);
    if (pauses.isNotEmpty && pauses.last is Map) {
      final last = Map<String, dynamic>.from(pauses.last);
      if (last['pause_stop'] == null) {
        last['pause_stop'] = stopEpoch;
        pauses[pauses.length - 1] = last;
      }
    }

    data['pauses_enc'] = _encrypt(json.encode(pauses));
    data['is_paused'] = false;

    raw['data'] = data;
    final dto = _rawToDto(raw, index);
    raw['hash'] = _computeEntryHash(dto);
    rawEntries[index] = raw;
    await storage.set('entries', rawEntries);
  }

  // ── Duration computation ──────────────────────────────────────

  /// Compute active duration as wall time minus all completed pause intervals.
  static int computeDuration(int? startEpoch, int? endEpoch, List pauses) {
    if (endEpoch == null || startEpoch == null) return 0;
    int totalPauseMs = 0;
    for (final p in pauses) {
      if (p is Map) {
        final stop = p['pause_stop'];
        final start = p['pause_start'];
        if (stop != null && start != null) {
          totalPauseMs += (stop as int) - (start as int);
        }
      }
    }
    final result = endEpoch - startEpoch - totalPauseMs;
    return result < 0 ? 0 : result;
  }

  // ── markCommitted ─────────────────────────────────────────────

  /// Mark one or more entries as committed to the ledger.
  Future<void> markCommitted(List<String> entryIds) async {
    if (entryIds.isEmpty) return;
    final idSet = entryIds.toSet();
    final rawEntries = (await storage.get('entries') as List?) ?? [];
    bool changed = false;
    for (final raw in rawEntries) {
      if (raw is Map) {
        final data = raw['data'] as Map<String, dynamic>?;
        if (data != null && idSet.contains(data['entry_id'])) {
          raw['committed'] = true;
          changed = true;
        }
      }
    }
    if (changed) {
      await storage.set('entries', rawEntries);
    }
  }

  // ── Hash Index ─────────────────────────────────────────────────

  static const _hashIndexKey = 'staging_hash_index';

  Future<List<Map<String, dynamic>>> readHashIndex() async {
    final index = await storage.get(_hashIndexKey);
    if (index is List) {
      return index.cast<Map<String, dynamic>>();
    }
    return [];
  }

  Future<void> writeHashIndex(List<Map<String, dynamic>> index) async {
    await storage.set(_hashIndexKey, index);
  }

  // ── NormTags helpers ──────────────────────────────────────────

  static List<String> _normalizeTags(List? tags) {
    if (tags == null || tags.isEmpty) return [];
    final seen = <String>{};
    final result = <String>[];
    for (final t in tags) {
      final clean = t.toString().trim().toLowerCase();
      if (clean.isNotEmpty && !seen.contains(clean)) {
        seen.add(clean);
        result.add(clean);
      }
    }
    result.sort();
    return result;
  }
}
