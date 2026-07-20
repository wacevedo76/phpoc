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

  /// Duration in milliseconds, accounting for pauses.
  int get durationMs {
    if (endEpoch == null) return 0;
    int total = endEpoch! - startEpoch;
    for (final p in pauses) {
      total -= p.durationMs;
    }
    return total < 0 ? 0 : total;
  }

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

  @override
  List<Object?> get props => [startEpoch, endEpoch];
}
