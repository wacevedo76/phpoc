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

  void _onPassphraseChanged(String value) {
    setState(() {
      // Clear error when user starts typing
      _errorMessage = null;
    });
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

              ],
            ),
          ),
        ),
      ),
    );
  }
}
