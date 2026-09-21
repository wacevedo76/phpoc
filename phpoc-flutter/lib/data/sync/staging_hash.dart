import 'dart:convert';

import 'package:phpoc_flutter/core/utils/hash_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show encodeValueNoSpaces;

/// Canonical-row bridge + key-independent staging hash (ADR-034 §4.1).
///
/// The P0 cross-client parity gate: `staging_hash` is a deterministic,
/// key-independent, byte-identical SHA-256 digest of the non-committed staging
/// rows' canonical plaintext form, so CLI (Python), Web (JS), and Flutter (Dart)
/// produce the same digest for the same logical staging state.
///
/// Spec (docs/design/STAGING_CHANGE_DETECTION_DESIGN.md §4.1):
///   staging_hash = SHA-256( encodeValueNoSpaces([ canonical_row(r) for r in
///                    non-committed rows ] sorted ascending by activity_id) )
///   canonical_row(r) = { activity_id, activity_status, activity, updated_at,
///                        committed }
///   activity = compact JSON in the pinned key order (title, start_epoch,
///              end_epoch, duration, tags, comment, media, entry_id, is_active,
///              is_paused, pauses, metadata, device_uuid, end_device_uuid,
///              block_index)
///   Normalization: comment '' → null.
///
/// The inner `activity` string is NOT key-sorted — its byte order is the
/// insertion order of the map built here, so it must match the pinned list
/// exactly. Only the outer 5-field row is key-sorted (by `encodeValueNoSpaces`).

/// Derive `activity_status` from a legacy staging DTO's flags.
///
/// Matches Web `_deriveStatusFromDTO` / Python `_derive_status_from_dto`:
///   is_active == false  → 'ended'
///   is_paused == true   → 'paused'
///   otherwise           → 'active'
String _deriveStatusFromDto(Map<String, dynamic> dto) {
  if (dto['is_active'] == false) return 'ended';
  if (dto['is_paused'] == true) return 'paused';
  return 'active';
}

/// Convert a legacy staging DTO to a canonical staging row.
///
/// Canonical rows store activity data as a JSON string under the `activity`
/// key (PHPSPEC §8). The `activity` map is built in the pinned key order so the
/// serialized string is byte-identical across clients.
///
/// [deviceId] is the fallback device UUID when the DTO has no `device_uuid`.
/// [now] is the fallback epoch-ms timestamp for `updated_at` (defaults to the
/// current time).
Map<String, dynamic> dtoToCanonicalRow(
  Map<String, dynamic> dto, {
  String deviceId = '',
  int? now,
}) {
  now ??= DateTime.now().millisecondsSinceEpoch;

  // comment: empty string → null (ADR-034 §4.1). Web uses `e.comment || null`.
  final rawComment = dto['comment'];
  final comment = (rawComment is String && rawComment.isNotEmpty)
      ? rawComment
      : null;

  final activity = <String, dynamic>{
    'title': dto['title'] ?? '',
    'start_epoch': dto['start_epoch'] ?? 0,
    'end_epoch': dto['end_epoch'],
    'duration': dto['duration'] ?? 0,
    'tags': dto['tags'] ?? <dynamic>[],
    'comment': comment,
    'media': dto['media'] ?? <dynamic>[],
    'entry_id': dto['entry_id'] ?? '',
    'is_active': dto['is_active'] ?? false,
    'is_paused': dto['is_paused'] ?? false,
    'pauses': dto['pauses'] ?? <dynamic>[],
    'metadata': dto['metadata'] is Map<String, dynamic>
        ? dto['metadata'] as Map<String, dynamic>
        : <String, dynamic>{},
    'device_uuid': dto['device_uuid'] ?? deviceId,
    'end_device_uuid': dto['end_device_uuid'] ?? '',
    'block_index': dto['block_index'],
  };

  return <String, dynamic>{
    'activity_id': dto['activity_id'] ?? dto['entry_id'] ?? '',
    'activity_status': _deriveStatusFromDto(dto),
    'activity': jsonEncode(activity),
    'updated_at': dto['updated_at'] ?? now,
    'committed': dto['committed'] == true,
  };
}

/// Compute the key-independent staging hash (ADR-034 §4.1).
///
/// SHA-256 of the canonical-array JSON over non-committed rows, sorted
/// ascending by `activity_id`. Byte-identical to Python
/// `domain/staging/row_merge.compute_staging_hash` and Web
/// `remote_sync.js computeStagingHash`.
///
/// [rows] are canonical staging rows (the 5-field PHPSPEC §8.1 form produced by
/// [dtoToCanonicalRow]). Committed rows are excluded (they moved to the ledger,
/// D11).
String computeStagingHash(List<Map<String, dynamic>> rows) {
  final uncommitted = rows.where((r) => r['committed'] != true).toList()
    ..sort((a, b) =>
        (a['activity_id'] as String).compareTo(b['activity_id'] as String));
  return sha256(encodeValueNoSpaces(uncommitted));
}
