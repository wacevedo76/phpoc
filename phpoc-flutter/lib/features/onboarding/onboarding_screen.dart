import 'package:flutter/material.dart';

/// Onboarding screen — first-time setup: New Ledger, Import, Connect to Worker.
///
/// TODO: Full implementation.
class OnboardingScreen extends StatelessWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Welcome to PH Ledger')),
      body: const Center(child: Text('Onboarding — coming soon')),
    );
  }
}
