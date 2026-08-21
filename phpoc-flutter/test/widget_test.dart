import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/app.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';

void main() {
  testWidgets('App boot transitions from loading to landing',
      (tester) async {
    // Hermetic providers: the app boots cleanly to the landing screen in a
    // bare widget test without touching the real platform secure storage or
    // on-disk database (which would hang or carry data from previous runs).
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          data_providers.databaseProvider.overrideWith((ref) {
            final db = AppDatabase.inMemory();
            ref.onDispose(() => db.close());
            return db;
          }),
          data_providers.appPreferencesProvider.overrideWith((ref) {
            return AppPreferences.testInstance();
          }),
          data_providers.securePreferencesProvider.overrideWith((ref) {
            return SecurePreferences.testInstance();
          }),
        ],
        child: const PhpocApp(),
      ),
    );
    // Pump a frame to allow the async initialization in LoadingScreen
    // to complete (in-memory providers resolve instantly).
    await tester.pump();
    // Let the async _initialize complete
    await tester.pump(const Duration(milliseconds: 100));

    // Fresh install (no existing data) → should land on the landing screen
    expect(find.text('PH Ledger'), findsOneWidget);
    expect(find.text('New Ledger'), findsOneWidget);
  });
}
