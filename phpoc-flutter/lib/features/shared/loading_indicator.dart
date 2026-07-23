import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../data/storage/providers.dart' as providers;
import '../../routing/app_router.dart';

/// Loading screen shown during app boot.
///
/// Initializes CryptoService and checks for existing data, then transitions
/// to the appropriate phase: auth (existing data) or landing (new user).
class LoadingScreen extends ConsumerStatefulWidget {
  const LoadingScreen({super.key});

  @override
  ConsumerState<LoadingScreen> createState() => _LoadingScreenState();
}

class _LoadingScreenState extends ConsumerState<LoadingScreen> {
  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      // Initialize crypto (PBKDF2 benchmark, etc.)
      final crypto = ref.read(providers.cryptoServiceProvider);
      await crypto.initialize();

      if (!mounted) return;

      // Check for existing data and route accordingly
      final onboarding = ref.read(providers.onboardingServiceProvider);
      final hasData = await onboarding.hasExistingData();

      if (!mounted) return;

      if (hasData) {
        ref.read(appLifecycleProvider.notifier).goToAuth();
      } else {
        ref.read(appLifecycleProvider.notifier).goToLanding();
      }
    } catch (_) {
      if (!mounted) return;
      // If initialization fails, go to landing so user can create a new ledger
      ref.read(appLifecycleProvider.notifier).goToLanding();
    }
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: LoadingIndicator(message: 'Initializing PH Ledger...'),
      ),
    );
  }
}

/// Shared loading indicator with optional message.
class LoadingIndicator extends StatelessWidget {
  final String? message;
  const LoadingIndicator({super.key, this.message});

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const CircularProgressIndicator(),
        if (message != null) ...[
          const SizedBox(height: 16),
          Text(message!, style: Theme.of(context).textTheme.bodyLarge),
        ],
      ],
    );
  }
}
