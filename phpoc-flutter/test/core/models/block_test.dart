import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/block.dart';

void main() {
  // ── Group C: Block ──────────────────────────────────────────

  group('Block', () {
    // C1 — Construct genesis block
    test('C1: construct genesis block', () {
      const block = Block(
        blockId: 'genesis-001',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'Z2VuZXNpc19kYXRh',
        prevHash: Block.genesisPrevHash,
        createdAt: 1700000000,
      );
      expect(block.blockId, 'genesis-001');
      expect(block.blockType, BlockType.genesis);
      expect(block.blockIndex, 0);
      expect(block.keyVersion, 1); // default
    });

    // C2 — Construct day block with entries
    test('C2: construct day block', () {
      const block = Block(
        blockId: 'day-001',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'ZGF5X2RhdGE=',
        prevHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        createdAt: 1700000000,
      );
      expect(block.blockType, BlockType.day);
    });

    // C3 — Construct month summary block
    test('C3: construct month summary block', () {
      const block = Block(
        blockId: 'month-001',
        blockType: BlockType.month,
        blockIndex: 2,
        dataEnc: 'bW9udGhfZGF0YQ==',
        identitySeal: 'seal123',
        prevHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        createdAt: 1700000000,
      );
      expect(block.blockType, BlockType.month);
    });

    // C4 — Construct year summary block
    test('C4: construct year summary block', () {
      const block = Block(
        blockId: 'year-001',
        blockType: BlockType.year,
        blockIndex: 3,
        dataEnc: 'eWVhcl9kYXRh',
        identitySeal: 'seal456',
        prevHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        createdAt: 1700000000,
      );
      expect(block.blockType, BlockType.year);
    });

    // C5 — Genesis block prev_hash is all zeros
    test('C5: genesis block prev_hash is all zeros', () {
      const block = Block(
        blockId: 'gen-1',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'data',
        prevHash: Block.genesisPrevHash,
        createdAt: 1700000000,
      );
      expect(block.prevHash, '0000000000000000000000000000000000000000000000000000000000000000');
      expect(block.prevHash, hasLength(64));
    });

    // C6 — Day block prev_hash links to prior block
    test('C6: day block prev_hash is non-zero (links to prior)', () {
      const prevHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const block = Block(
        blockId: 'day-2',
        blockType: BlockType.day,
        blockIndex: 2,
        dataEnc: 'data',
        prevHash: prevHash,
        createdAt: 1700000001,
      );
      expect(block.prevHash, prevHash);
      expect(block.prevHash, isNot(Block.genesisPrevHash));
    });

    // C7 — block_type enum validation
    test('C7: block_type covers all four types', () {
      expect(BlockType.values, hasLength(4));
      expect(BlockType.values, containsAll([
        BlockType.genesis,
        BlockType.year,
        BlockType.month,
        BlockType.day,
      ]));
    });

    // C8 — JSON roundtrip
    test('C8: toJson → fromJson roundtrip is equal', () {
      const block = Block(
        blockId: 'rt-block',
        blockType: BlockType.day,
        blockIndex: 5,
        keyVersion: 2,
        dataEnc: 'dGVzdF9kYXRh',
        identitySeal: 'seal_xyz',
        prevHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: 1700000000,
      );
      final restored = Block.fromJson(block.toJson());
      expect(restored, block);
    });

    // C9 — JSON roundtrip preserves data_enc
    test('C9: JSON roundtrip preserves data_enc payload', () {
      const block = Block(
        blockId: 'data-test',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'bXlfZW5jcnlwdGVkX2Jsb2JfaGVyZQ==',
        prevHash: Block.genesisPrevHash,
        createdAt: 1700000000,
      );
      final restored = Block.fromJson(block.toJson());
      expect(restored.dataEnc, block.dataEnc);
    });

    // C10 — JSON roundtrip with null identity_seal
    test('C10: JSON roundtrip with null identity_seal', () {
      const block = Block(
        blockId: 'no-seal',
        blockType: BlockType.day,
        blockIndex: 10,
        dataEnc: 'data',
        prevHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        createdAt: 1700000000,
      );
      final restored = Block.fromJson(block.toJson());
      expect(restored.identitySeal, isNull);
      expect(restored, block);
    });

    // C11 — Two blocks with same fields are equal
    test('C11: identical blocks are equal', () {
      const prevHash = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
      const a = Block(
        blockId: 'eq-1', blockType: BlockType.day, blockIndex: 1,
        dataEnc: 'x', prevHash: prevHash, createdAt: 100,
      );
      const b = Block(
        blockId: 'eq-1', blockType: BlockType.day, blockIndex: 1,
        dataEnc: 'x', prevHash: prevHash, createdAt: 100,
      );
      expect(a, b);
    });

    // C12 — Different block_index → not equal
    test('C12: different block_index are not equal', () {
      const prevHash = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
      const a = Block(
        blockId: 'x', blockType: BlockType.day, blockIndex: 1,
        dataEnc: 'x', prevHash: prevHash, createdAt: 100,
      );
      const b = Block(
        blockId: 'x', blockType: BlockType.day, blockIndex: 2,
        dataEnc: 'x', prevHash: prevHash, createdAt: 100,
      );
      expect(a, isNot(b));
    });
  });
}
