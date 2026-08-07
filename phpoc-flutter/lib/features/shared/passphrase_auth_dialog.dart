import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/storage/providers.dart';
import '../../services/auth_service.dart';

/// Passphrase authentication dialog for on-demand encrypted entry decryption.
///
/// Uses [AuthService.reauthenticate] to validate the passphrase against the
/// genesis block. On success, calls [onAuthenticated] with the derived master
/// key hex string. On cancel or dismissal, calls [onCancel].
class PassphraseAuthDialog extends ConsumerStatefulWidget {
  /// Called with the derived master key (hex string) on successful auth.
  final void Function(String mkHex)? onAuthenticated;

  /// Called when the user dismisses the dialog without authenticating.
  final VoidCallback? onCancel;

  const PassphraseAuthDialog({
    super.key,
    this.onAuthenticated,
    this.onCancel,
  });

  @override
  ConsumerState<PassphraseAuthDialog> createState() =>
      _PassphraseAuthDialogState();
}

class _PassphraseAuthDialogState extends ConsumerState<PassphraseAuthDialog> {
  final _passphraseController = TextEditingController();
  bool _obscureText = true;
  bool _isLoading = false;
  String? _errorMessage;

  @override
  void dispose() {
    _passphraseController.dispose();
    super.dispose();
  }

  Future<void> _authenticate() async {
    final passphrase = _passphraseController.text.trim();
    if (passphrase.isEmpty) return;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final authService = ref.read(authServiceProvider);
      await authService.reauthenticate(passphrase);

      if (!mounted) return;
      // reauthenticate() already cached the MK in CryptoService via setMasterKey()
      final mk = ref.read(cryptoServiceProvider).getMasterKey();
      if (mk != null) {
        widget.onAuthenticated?.call(mk);
      }
      if (mounted) Navigator.of(context).pop();
    } on AuthException catch (e) {
      if (mounted) {
        setState(() => _errorMessage = e.message);
      }
    } catch (e) {
      debugPrint('PassphraseAuthDialog: unexpected auth error: $e');
      if (mounted) {
        setState(() => _errorMessage = 'Authentication failed');
      }
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  void _cancel() {
    widget.onCancel?.call();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Enter Passphrase'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _passphraseController,
            obscureText: _obscureText,
            decoration: InputDecoration(
              labelText: 'Passphrase',
              suffixIcon: IconButton(
                icon: Icon(
                  _obscureText ? Icons.visibility_off : Icons.visibility,
                ),
                onPressed: () =>
                    setState(() => _obscureText = !_obscureText),
              ),
            ),
          ),
          if (_errorMessage != null) ...[
            const SizedBox(height: 8),
            Text(
              _errorMessage!,
              style: TextStyle(
                color: Theme.of(context).colorScheme.error,
                fontSize: 12,
              ),
            ),
          ],
          if (_isLoading) const Padding(
            padding: EdgeInsets.only(top: 12),
            child: CircularProgressIndicator(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _isLoading ? null : _cancel,
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: _isLoading ? null : _authenticate,
          child: const Text('Authenticate'),
        ),
      ],
    );
  }
}
