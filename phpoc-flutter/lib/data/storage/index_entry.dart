import 'package:equatable/equatable.dart';

/// A blind-index entry linking a tag/date to a committed entry within a block.
///
/// Used by the ledger engine for O(1) lookups by date and tag.
class IndexEntry extends Equatable {
  final int? id;
  final String blockId;
  final String date;
  final String tag;
  final String entryId;

  const IndexEntry({
    this.id,
    required this.blockId,
    required this.date,
    required this.tag,
    required this.entryId,
  });

  IndexEntry withId(int newId) => IndexEntry(
        id: newId,
        blockId: blockId,
        date: date,
        tag: tag,
        entryId: entryId,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'block_id': blockId,
        'date': date,
        'tag': tag,
        'entry_id': entryId,
      };

  factory IndexEntry.fromJson(Map<String, dynamic> json) => IndexEntry(
        id: json['id'] as int?,
        blockId: json['block_id'] as String,
        date: json['date'] as String,
        tag: json['tag'] as String,
        entryId: json['entry_id'] as String,
      );

  @override
  List<Object?> get props => [id, blockId, date, tag, entryId];
}
