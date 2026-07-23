import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Landing screen — first screen for new users with no existing data.
/// Outside the main AppScaffold — no bottom nav.
class LandingScreen extends StatelessWidget {
  const LandingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // App branding
                Icon(
                  Icons.lock_clock,
                  size: 72,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(height: 16),
                Text(
                  'PH Ledger',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Personal History Protocol',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
                const SizedBox(height: 48),
                // New Ledger button — new users
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: () => context.go('/onboarding'),
                    icon: const Icon(Icons.add_circle_outline),
                    label: const Text('New Ledger'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
