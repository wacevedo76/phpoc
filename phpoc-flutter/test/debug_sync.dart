import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as p;
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/features/sync/sync_screen.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

class _Storage {
  final Map<String, dynamic> d = {};
  Future<dynamic> get(String k) async => d[k];
  Future<void> set(String k, dynamic v) async => d[k] = v;
  Future<void> remove(String k) async => d.remove(k);
}
class _T extends HttpTransport {
  _T() : super(baseUrl: 'https://t.com', apiKey: 'k');
  @override Future<Uint8List?> pull(String p) async => null;
  @override Future<void> push(String p, Uint8List d) async {
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  @override Future<List<String>> listFiles(String p) async => [];
  @override Future<void> delete(String p) async {}
}

void main() {
  testWidgets('debug', (tester) async {
    final db = AppDatabase.inMemory();
    final t = _T();
    final c = CryptoService()..initialize();
    c.setMasterKey('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await db.blockDao.insertBlock(Block(
      blockId: 'test', blockType: BlockType.day, blockIndex: 1,
      dataEnc: 'e30=', prevHash: Block.genesisPrevHash,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      identitySeal: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    ));
    final sync = SyncService(storage: _Storage(), crypto: c, transport: t);
    final push = LedgerPushService(db: db, crypto: c, transport: t);

    await tester.pumpWidget(ProviderScope(
      overrides: [
        p.databaseProvider.overrideWith((ref) => db),
        p.cryptoServiceProvider.overrideWith((ref) => c),
        p.appPreferencesProvider.overrideWith((ref) => AppPreferences.testInstance()),
        p.securePreferencesProvider.overrideWith((ref) => SecurePreferences.testInstance()),
        p.syncServiceProvider.overrideWith((ref) => sync),
        p.authServiceProvider.overrideWith((ref) => AuthService(crypto: c, db: db, preferences: AppPreferences.testInstance())),
        p.onboardingServiceProvider.overrideWith((ref) => OnboardingService(crypto: c, db: db, preferences: AppPreferences.testInstance(), securePreferences: SecurePreferences.testInstance(), syncService: sync)),
        p.ledgerPushServiceProvider.overrideWith((ref) => push),
        appLifecycleProvider.overrideWith((ref) => AppLifecycleNotifier()..goToReady()),
      ],
      child: const MaterialApp(home: SyncScreen()),
    ));
    await tester.pump();

    final btn = find.text('Push Ledger to Cloud');
    print('BTN found: ${btn.evaluate().length}');
    if (btn.evaluate().isNotEmpty) {
      await tester.tap(btn);
      await tester.pump();
      print('Pushing text: ${find.text("Pushing…").evaluate().length}');
      print('Spinners: ${find.byType(CircularProgressIndicator).evaluate().length}');
      final eb = find.byType(ElevatedButton);
      print('ElevatedButtons: ${eb.evaluate().length}');
    }
  });
}
