import 'package:flutter/material.dart';

/// Settings — Worker config, passphrase change, seed export, about.
///
/// TODO: Full implementation.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: const Center(child: Text('Settings — coming soon')),
    );
  }
}
