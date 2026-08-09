import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show authServiceProvider;
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

/// Unlock screen — passphrase entry for login.
///
/// Validates passphrase and delegates to AuthService.unlock().
/// Shown at AppPhase.auth — outside the main AppScaffold.
class UnlockScreen extends ConsumerStatefulWidget {
  const UnlockScreen({super.key});

  @override
  ConsumerState<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends ConsumerState<UnlockScreen> {
  final _passphraseController = TextEditingController();
  bool _obscureText = true;
  bool _isLoading = false;
  String? _errorMessage;
  String? _bioErrorMessage;
  bool _isBioLoading = false;
  bool _biometricsAvailable = false;
  bool _biometricEnabled = false;
  bool _isWiping = false;
  String? _wipeErrorMessage;

  @override
  void dispose() {
    _passphraseController.dispose();
    super.dispose();
  }

  Future<void> _unlock() async {
    final passphrase = _passphraseController.text.trim();

    // Validate non-empty
    if (passphrase.isEmpty) {
      setState(() => _errorMessage = 'Please enter your passphrase');
      return;
    }

    // Validate length
    if (passphrase.length < 8) {
      setState(
          () => _errorMessage = 'Passphrase must be at least 8 characters');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final authService = ref.read(authServiceProvider);
      // Extract the real seed from the genesis block using the passphrase.
      // The seed is encrypted in genesis.data_enc, decryptable with PDK.
      // This ensures MK is derived from the correct seed regardless of
      // whether the user created, imported, or restored the ledger.
      await authService.reauthenticate(passphrase);

      if (!mounted) return;
      final lifecycle = ref.read(appLifecycleProvider.notifier);
      lifecycle.goToReady();
    } on AuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _errorMessage = e.message;
      });
    } on FormatException catch (e) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _errorMessage = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _errorMessage = 'An unexpected error occurred';
      });
    }
  }

  @override
  void initState() {
    super.initState();
    _checkBiometricState();
  }

  Future<void> _checkBiometricState() async {
    final authService = ref.read(authServiceProvider);
    final available = await authService.isBiometricsAvailable();
    final enabled = authService.isBiometricEnabled();
    if (!mounted) return;
    setState(() {
      _biometricsAvailable = available;
      _biometricEnabled = enabled;
    });
  }

  Future<void> _biometricUnlock() async {
    setState(() {
      _isBioLoading = true;
      _bioErrorMessage = null;
    });

    try {
      final authService = ref.read(authServiceProvider);
      final success = await authService.unlockWithBiometric();

      if (!mounted) return;

      if (success) {
        final lifecycle = ref.read(appLifecycleProvider.notifier);
        lifecycle.goToReady();
      } else {
        // Biometric failed or cancelled — user can fall back to passphrase.
        // No error message unless the auth service threw (unexpected).
        setState(() => _isBioLoading = false);
      }
    } on AuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _isBioLoading = false;
        _bioErrorMessage = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isBioLoading = false;
        _bioErrorMessage = 'Biometric authentication unavailable';
      });
    }
  }

  void _onPassphraseChanged(String value) {
    setState(() {
      // Clear error when user starts typing
      _errorMessage = null;
      _bioErrorMessage = null;
    });
  }

  Future<void> _showWipeConfirmation() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Wipe Ledger'),
        content: const Text(
          'This will permanently delete all local data:\n'
          '• All ledger entries and blocks\n'
          '• All staging data\n'
          '• Your master key and credentials\n\n'
          'Cloud data (R2) will NOT be affected.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
            ),
            child: const Text('Wipe Ledger'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      await _executeWipe();
    }
  }

  Future<void> _executeWipe() async {
    setState(() {
      _isWiping = true;
      _wipeErrorMessage = null;
    });

    try {
      final authService = ref.read(authServiceProvider);
      await authService.wipeLedger();

      if (!mounted) return;
      final lifecycle = ref.read(appLifecycleProvider.notifier);
      lifecycle.goToLanding();
    } on Exception catch (e) {
      if (!mounted) return;
      setState(() {
        _isWiping = false;
        _wipeErrorMessage = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PH Ledger')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.lock_outline,
                  size: 64,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(height: 16),
                Text(
                  'Enter your passphrase',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 24),
                // ── Biometric unlock ──────────────────────────
                if (_biometricsAvailable && _biometricEnabled) ...[
                  _isBioLoading
                      ? const SizedBox(
                          width: 48,
                          height: 48,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : IconButton(
                          icon: const Icon(Icons.fingerprint, size: 48),
                          color: Theme.of(context).colorScheme.primary,
                          onPressed: _biometricUnlock,
                        ),
                  const SizedBox(height: 8),
                  if (_bioErrorMessage != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        _bioErrorMessage!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                          fontSize: 12,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  const SizedBox(height: 8),
                ],
                // Passphrase field with visibility toggle
                TextField(
                  controller: _passphraseController,
                  obscureText: _obscureText,
                  onChanged: _onPassphraseChanged,
                  onSubmitted: (_) => _unlock(),
                  autofocus: true,
                  style: const TextStyle(fontFamily: 'monospace'),
                  decoration: InputDecoration(
                    labelText: 'Passphrase',
                    hintText: 'Enter your passphrase',
                    prefixIcon: const Icon(Icons.key),
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureText
                            ? Icons.visibility
                            : Icons.visibility_off,
                      ),
                      onPressed: () {
                        setState(() => _obscureText = !_obscureText);
                      },
                    ),
                    errorText: _errorMessage,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 24),
                // Unlock button
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _isLoading ? null : _unlock,
                    child: _isLoading
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('Unlock'),
                  ),
                ),
                const SizedBox(height: 16),
                // Wipe Ledger button
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: (_isLoading || _isWiping) ? null : _showWipeConfirmation,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Theme.of(context).colorScheme.error,
                    ),
                    child: _isWiping
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                            ),
                          )
                        : const Text('Wipe Ledger'),
                  ),
                ),
                if (_wipeErrorMessage != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _wipeErrorMessage!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      fontSize: 12,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],

              ]
            ),
          ),
        ),
      ),
    );
  }
}
