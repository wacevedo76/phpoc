import 'package:equatable/equatable.dart';

/// Block types in the ledger chain hierarchy.
enum BlockType { genesis, year, month, day }

/// A block in the PH ledger chain.
class Block extends Equatable {
  final String blockId;
  final BlockType blockType;
  final int blockIndex;
  final int keyVersion;
  final String dataEnc;        // encrypted JSON, base64
  final String? identitySeal;  // HMAC seal (null for day blocks)
  final String prevHash;       // 64-char hex (all zeros for genesis)
  final int createdAt;         // epoch seconds

  const Block({
    required this.blockId,
    required this.blockType,
    required this.blockIndex,
    this.keyVersion = 1,
    required this.dataEnc,
    this.identitySeal,
    required this.prevHash,
    required this.createdAt,
  });

  /// Genesis blocks have a prev_hash of all zeros.
  static const String genesisPrevHash =
      '0000000000000000000000000000000000000000000000000000000000000000';

  /// JSON serialization.
  Map<String, dynamic> toJson() => {
        'block_id': blockId,
        'block_type': blockType.name,
        'block_index': blockIndex,
        'key_version': keyVersion,
        'data_enc': dataEnc,
        'identity_seal': identitySeal,
        'prev_hash': prevHash,
        'created_at': createdAt,
      };

  factory Block.fromJson(Map<String, dynamic> json) => Block(
        blockId: json['block_id'] as String,
        blockType: BlockType.values.byName(json['block_type'] as String),
        blockIndex: json['block_index'] as int,
        keyVersion: json['key_version'] as int? ?? 1,
        dataEnc: json['data_enc'] as String,
        identitySeal: json['identity_seal'] as String?,
        prevHash: json['prev_hash'] as String,
        createdAt: json['created_at'] as int,
      );

  @override
  List<Object?> get props => [
        blockId,
        blockType,
        blockIndex,
        keyVersion,
        dataEnc,
        identitySeal,
        prevHash,
        createdAt,
      ];
}
