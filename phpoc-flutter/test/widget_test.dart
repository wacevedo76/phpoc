import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/app.dart';

void main() {
  testWidgets('App renders loading screen on boot', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: PhpocApp()),
    );
    await tester.pump();

    // Boot phase shows loading indicator
    expect(find.text('Initializing PH Ledger...'), findsOneWidget);
  });
}
