import 'package:equatable/equatable.dart';

/// A staging or committed entry — the core data type of the PH Ledger.
class Entry extends Equatable {
  final String entryId;
  final String title;
  final int startEpoch;
  final int? endEpoch;
  final bool isActive;
  final bool committed;
  final List<String> tags;
  final List<PauseRecord> pauses;
  final String? metadataEnc;      // encrypted metadata, base64
  final String? deviceUuid;
  final String? contentHash;

  const Entry({
    required this.entryId,
    required this.title,
    required this.startEpoch,
    this.endEpoch,
    this.isActive = true,
    this.committed = false,
    this.tags = const [],
    this.pauses = const [],
    this.metadataEnc,
    this.deviceUuid,
    this.contentHash,
  });

  /// Create a copy with some fields replaced.
  Entry copyWith({
    String? entryId,
    String? title,
    int? startEpoch,
    int? endEpoch,
    bool? isActive,
    bool? committed,
    List<String>? tags,
    List<PauseRecord>? pauses,
    String? metadataEnc,
    String? deviceUuid,
    String? contentHash,
  }) {
    return Entry(
      entryId: entryId ?? this.entryId,
      title: title ?? this.title,
      startEpoch: startEpoch ?? this.startEpoch,
      endEpoch: endEpoch ?? this.endEpoch,
      isActive: isActive ?? this.isActive,
      committed: committed ?? this.committed,
      tags: tags ?? this.tags,
      pauses: pauses ?? this.pauses,
      metadataEnc: metadataEnc ?? this.metadataEnc,
      deviceUuid: deviceUuid ?? this.deviceUuid,
      contentHash: contentHash ?? this.contentHash,
    );
  }

  /// Duration in milliseconds, accounting for pauses.
  int get durationMs {
    if (endEpoch == null) return 0;
    int total = endEpoch! - startEpoch;
    for (final p in pauses) {
      total -= p.durationMs;
    }
    return total < 0 ? 0 : total;
  }

  /// Serialize to JSON.
  Map<String, dynamic> toJson() => {
        'entry_id': entryId,
        'title': title,
        'start_epoch': startEpoch,
        'end_epoch': endEpoch,
        'is_active': isActive,
        'committed': committed,
        'tags': tags,
        'pauses': pauses.map((p) => p.toJson()).toList(),
        'metadata_enc': metadataEnc,
        'device_uuid': deviceUuid,
        'content_hash': contentHash,
      };

  /// Deserialize from JSON.
  factory Entry.fromJson(Map<String, dynamic> json) => Entry(
        entryId: json['entry_id'] as String,
        title: json['title'] as String,
        startEpoch: json['start_epoch'] as int,
        endEpoch: json['end_epoch'] as int?,
        isActive: json['is_active'] as bool? ?? true,
        committed: json['committed'] as bool? ?? false,
        tags: (json['tags'] as List<dynamic>?)?.cast<String>() ?? const [],
        pauses: (json['pauses'] as List<dynamic>?)
                ?.map((p) => PauseRecord.fromJson(p as Map<String, dynamic>))
                .toList() ??
            const [],
        metadataEnc: json['metadata_enc'] as String?,
        deviceUuid: json['device_uuid'] as String?,
        contentHash: json['content_hash'] as String?,
      );

  @override
  List<Object?> get props => [
        entryId,
        title,
        startEpoch,
        endEpoch,
        isActive,
        committed,
        tags,
        pauses,
        metadataEnc,
        deviceUuid,
        contentHash,
      ];
}

/// A pause record within an entry.
class PauseRecord extends Equatable {
  final int startEpoch;
  final int? endEpoch;

  const PauseRecord({required this.startEpoch, this.endEpoch});

  int get durationMs {
    if (endEpoch == null) return 0;
    return endEpoch! - startEpoch;
  }

  bool get isOpen => endEpoch == null;

  /// Serialize to JSON.
  Map<String, dynamic> toJson() => {
        'start_epoch': startEpoch,
        'end_epoch': endEpoch,
      };

  /// Deserialize from JSON.
  factory PauseRecord.fromJson(Map<String, dynamic> json) => PauseRecord(
        startEpoch: json['start_epoch'] as int,
        endEpoch: json['end_epoch'] as int?,
      );

  @override
  List<Object?> get props => [startEpoch, endEpoch];
}
