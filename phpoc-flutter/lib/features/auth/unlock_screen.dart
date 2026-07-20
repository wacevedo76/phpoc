import 'package:flutter/material.dart';

/// Unlock screen — passphrase entry for login.
///
/// TODO: Full implementation with biometric fallback.
class UnlockScreen extends StatelessWidget {
  const UnlockScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Unlock')),
      body: const Center(child: Text('Enter passphrase — coming soon')),
    );
  }
}
