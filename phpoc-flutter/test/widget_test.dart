import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/app.dart';

void main() {
  testWidgets('App boot transitions from loading to landing',
      (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: PhpocApp()),
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
