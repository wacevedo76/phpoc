import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show appPreferencesProvider, authServiceProvider, ledgerBackupServiceProvider,
    onboardingServiceProvider, securePreferencesProvider, syncServiceProvider;
import 'package:phpoc_flutter/data/sync/transport.dart' show HttpTransport;
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

/// Settings — Worker config, passphrase change, seed export, about.
///
/// Full settings panel accessible from the bottom navigation bar.
/// All operations delegate to AuthService or OnboardingService.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  // Worker config state
  String? _workerUrl;
  bool _workerConnected = false;
  bool _showWorkerEditor = false;
  final _workerUrlController = TextEditingController();
  final _workerApiKeyController = TextEditingController();

  // Passphrase change state
  bool _showPassphraseEditor = false;
  final _oldPassphraseController = TextEditingController();
  final _newPassphraseController = TextEditingController();
  bool _isChangingPassphrase = false;
  String? _passphraseError;

  // Seed export state
  bool _isExporting = false;
  final _exportPassphraseController = TextEditingController();

  @override
  void dispose() {
    _workerUrlController.dispose();
    _workerApiKeyController.dispose();
    _oldPassphraseController.dispose();
    _newPassphraseController.dispose();
    _exportPassphraseController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  void _loadStatus() {
    final sync = ref.read(syncServiceProvider);
    final prefs = ref.read(appPreferencesProvider);
    final securePrefs = ref.read(securePreferencesProvider);

    // Restore transport from saved credentials if not already wired
    if (!sync.isRemoteAvailable) {
      _restoreTransport(prefs, securePrefs, sync);
    }

    // Read saved URL for display (fire-and-forget — updates after async I/O)
    prefs.getWorkerUrl().then((savedUrl) {
      if (!mounted) return;
      setState(() {
        _workerUrl = (savedUrl != null && savedUrl.isNotEmpty)
            ? savedUrl
            : 'Not configured';
        _workerConnected = sync.isRemoteAvailable;
      });
    });
  }

  /// Wire up [HttpTransport] from saved [AppPreferences] and
  /// [SecurePreferences] when credentials exist but transport is null
  /// (fresh app start after onboarding / settings restore).
  Future<void> _restoreTransport(
    dynamic prefs,
    dynamic securePrefs,
    dynamic sync,
  ) async {
    try {
      final url = await prefs.getWorkerUrl();
      final apiKey = await securePrefs.getApiKey();
      if (url != null && url.isNotEmpty && apiKey != null && apiKey.isNotEmpty) {
        sync.transport = HttpTransport(baseUrl: url, apiKey: apiKey);
        if (mounted) {
          setState(() => _workerConnected = true);
        }
      }
    } catch (_) {
      // Ignore — transport restore is best-effort; user can re-enter
    }
  }

  // ── Worker Config ────────────────────────────────────────────

  void _toggleWorkerEditor() {
    setState(() => _showWorkerEditor = !_showWorkerEditor);
  }

  Future<void> _saveWorkerConfig() async {
    final url = _workerUrlController.text.trim();
    final apiKey = _workerApiKeyController.text.trim();

    if (url.isEmpty) return;

    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme || !uri.hasAuthority) {
      _showError('Invalid URL format');
      return;
    }

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      await onboarding.connectWorker(url, apiKey);

      if (!mounted) return;
      setState(() {
        _showWorkerEditor = false;
        _workerUrl = url;
        _workerConnected = true;
      });
    } catch (e) {
      if (mounted) _showError('Failed to connect: $e');
    }
  }

  // ── Passphrase Change ────────────────────────────────────────

  void _togglePassphraseEditor() {
    setState(() {
      _showPassphraseEditor = !_showPassphraseEditor;
      _passphraseError = null;
    });
  }

  Future<void> _changePassphrase() async {
    final oldPw = _oldPassphraseController.text;
    final newPw = _newPassphraseController.text;

    if (newPw.length < 8) {
      setState(() => _passphraseError = 'New passphrase must be at least 8 characters');
      return;
    }

    setState(() {
      _isChangingPassphrase = true;
      _passphraseError = null;
    });

    try {
      final auth = ref.read(authServiceProvider);
      await auth.changePassphrase(oldPw, newPw);

      if (!mounted) return;
      setState(() {
        _isChangingPassphrase = false;
        _showPassphraseEditor = false;
        _oldPassphraseController.clear();
        _newPassphraseController.clear();
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Passphrase changed successfully')),
      );
    } on AuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _isChangingPassphrase = false;
        _passphraseError = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isChangingPassphrase = false;
        _passphraseError = 'Failed to change passphrase';
      });
    }
  }

  // ── Seed Export ──────────────────────────────────────────────

  void _showSeedExportWarning() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Export Recovery Seed'),
        content: const Text(
          'Your recovery seed will be displayed on screen. Make sure no one '
          'else can see your screen before proceeding.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              _exportSeed();
            },
            child: const Text('Show Seed'),
          ),
        ],
      ),
    );
  }

  Future<void> _exportSeed() async {
    // Prompt for passphrase re-authentication
    final passphrase = await _showPassphrasePrompt();
    if (passphrase == null || !mounted) return; // User canceled

    setState(() => _isExporting = true);

    try {
      final auth = ref.read(authServiceProvider);
      final seed = await auth.exportSeed(passphrase);

      if (!mounted) return;

      // Save seed to file
      final path = await FilePicker.saveFile(
        dialogTitle: 'Save Recovery Seed',
        fileName: 'phpoc_seed.txt',
        type: FileType.custom,
        allowedExtensions: ['txt'],
      );

      if (path != null) {
        final file = File(path);
        await file.writeAsString(seed);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Seed saved to $path')),
          );
        }
      }
    } on AuthException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message)),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to export seed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isExporting = false);
    }
  }

  Future<String?> _showPassphrasePrompt() async {
    final controller = TextEditingController();

    final value = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Verify Passphrase'),
        content: TextField(
          controller: controller,
          obscureText: true,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Passphrase',
            hintText: 'Enter your passphrase to export seed',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (value) {
            if (value.isNotEmpty) Navigator.of(ctx).pop(value);
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final v = controller.text;
              if (v.isNotEmpty) Navigator.of(ctx).pop(v);
            },
            child: const Text('Export'),
          ),
        ],
      ),
    );

    // Allow dialog dismiss animation to complete before disposing the
    // controller, avoiding "A TextEditingController was used after being
    // disposed" error during the dismiss animation.
    await Future.delayed(const Duration(milliseconds: 300));
    controller.dispose();

    return value;
  }

  // ── Ledger Backup / Restore ────────────────────────────────

  Future<void> _backupLedger() async {
    try {
      final backupService = ref.read(ledgerBackupServiceProvider);
      final json = await backupService.exportToJson();

      if (!mounted) return;

      final path = await FilePicker.saveFile(
        dialogTitle: 'Save Ledger Backup',
        fileName: 'phpoc_ledger_backup.json',
        type: FileType.custom,
        allowedExtensions: ['json'],
      );

      if (path != null && mounted) {
        final file = File(path);
        await file.writeAsString(json);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Ledger backup saved to $path')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to export: $e')),
        );
      }
    }
  }

  Future<void> _restoreLedger() async {
    // Confirm dialog — restore replaces ALL data
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Restore Ledger Backup'),
        content: const Text(
          'This will replace ALL current ledger data with the backup file. '
          'This action cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            child: const Text('Replace Data'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['json'],
        withReadStream: true,
      );

      if (result == null || result.files.isEmpty) return; // User canceled

      final file = result.files.first;
      if (file.size > 10 * 1024 * 1024) {
        // 10 MiB limit
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Backup file is too large')),
          );
        }
        return;
      }

      final stream = file.readStream;
      if (stream == null) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not read file')),
          );
        }
        return;
      }

      final chunks = await stream.toList();
      final bytes = chunks.expand((chunk) => chunk).toList();
      final json = utf8.decode(bytes);

      final backupService = ref.read(ledgerBackupServiceProvider);
      await backupService.importFromJson(json);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Ledger restored successfully')),
      );
    } on FormatException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Invalid backup file: ${e.message}')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to restore: $e')),
        );
      }
    }
  }

  // ── Clear All Data ─────────────────────────────────────────

  Future<void> _clearAllData() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear All Data'),
        content: const Text(
          'This will permanently delete all entries, history, sync '
          'configuration, and device identity from this device.\n\n'
          'This action cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            child: const Text('Delete Everything'),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      final onboarding = ref.read(onboardingServiceProvider);
      await onboarding.clearAllData();
      if (!mounted) return;
      ref.read(appLifecycleProvider.notifier).goToLanding();
    }
  }

  // ── Lock ─────────────────────────────────────────────────────

  void _lock() {
    final auth = ref.read(authServiceProvider);
    auth.lock();
    ref.read(appLifecycleProvider.notifier).goToAuth();
  }

  void _showLockConfirmation() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Lock PH Ledger'),
        content: const Text(
          'This will clear your master key from memory and return to the unlock screen.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              // Delay lock until dialog dismiss animation completes to avoid
              // a Flutter _FocusInheritedScope assertion when the focused
              // widget is deactivated during the dismiss animation.
              Future.delayed(const Duration(milliseconds: 300), () {
                if (mounted) _lock();
              });
            },
            child: const Text('Lock / Log Out'),
          ),
        ],
      ),
    );
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg)),
    );
  }

  // ── Build ────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── Worker Config ────────────────────────────────────
          _buildSectionHeader('Remote Sync'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.cloud_outlined),
                  title: const Text('Worker'),
                  subtitle: Text(_workerUrl ?? 'Not configured'),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        _workerConnected
                            ? Icons.check_circle
                            : Icons.cancel,
                        size: 16,
                        color: _workerConnected ? Colors.green : Colors.grey,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        _workerConnected ? 'Connected' : 'Disconnected',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(width: 8),
                      const Icon(Icons.chevron_right),
                    ],
                  ),
                  onTap: _toggleWorkerEditor,
                ),
                if (_showWorkerEditor) _buildWorkerEditor(),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // ── Passphrase Change ─────────────────────────────────
          _buildSectionHeader('Security'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.key),
                  title: const Text('Change Passphrase'),
                  subtitle: const Text('Update your encryption passphrase'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _togglePassphraseEditor,
                ),
                if (_showPassphraseEditor) _buildPassphraseEditor(),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.vpn_key_outlined),
                  title: const Text('Export Recovery Seed'),
                  subtitle: const Text('Back up your recovery seed'),
                  enabled: !_isExporting,
                  onTap: _showSeedExportWarning,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.backup_outlined),
                  title: const Text('Backup Ledger'),
                  subtitle: const Text('Export full ledger to a .json file'),
                  onTap: _backupLedger,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: Icon(Icons.restore_outlined,
                      color: Theme.of(context).colorScheme.error),
                  title: const Text('Restore Ledger'),
                  subtitle: const Text('Replace all data from a backup file'),
                  onTap: _restoreLedger,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: Icon(Icons.delete_forever_outlined,
                      color: Theme.of(context).colorScheme.error),
                  title: const Text('Clear All Data'),
                  subtitle: const Text('Delete all entries, history, and configuration'),
                  onTap: _clearAllData,
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // ── Session ───────────────────────────────────────────
          _buildSectionHeader('Session'),
          Card(
            child: ListTile(
              leading: Icon(Icons.lock_outline,
                  color: Theme.of(context).colorScheme.error),
              title: const Text('Lock / Log Out'),
              subtitle: const Text('Clear master key and return to unlock'),
              onTap: _showLockConfirmation,
            ),
          ),
          const SizedBox(height: 24),

          // ── About ─────────────────────────────────────────────
          _buildSectionHeader('About'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.info_outline),
                  title: const Text('PH Ledger'),
                  subtitle: const Text('Personal History Protocol'),
                ),
                ListTile(
                  leading: const Icon(Icons.tag),
                  title: const Text('Version'),
                  subtitle: const Text('0.1.0 (Flutter MVP)'),
                ),
                ListTile(
                  leading: const Icon(Icons.code),
                  title: const Text('Build'),
                  subtitle: const Text('flutter • dart • riverpod'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Theme.of(context).colorScheme.primary,
              fontWeight: FontWeight.bold,
            ),
      ),
    );
  }

  Widget _buildWorkerEditor() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _workerUrlController,
            decoration: const InputDecoration(
              labelText: 'Worker URL',
              hintText: 'https://worker.example.com',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _workerApiKeyController,
            decoration: const InputDecoration(
              labelText: 'API Key',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _toggleWorkerEditor,
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  onPressed: _saveWorkerConfig,
                  child: const Text('Save'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPassphraseEditor() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _oldPassphraseController,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Old Passphrase',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _newPassphraseController,
            obscureText: true,
            decoration: InputDecoration(
              labelText: 'New Passphrase',
              border: const OutlineInputBorder(),
              isDense: true,
              errorText: _passphraseError,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _togglePassphraseEditor,
                  child: const Text('Cancel'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  onPressed: _isChangingPassphrase ? null : _changePassphrase,
                  child: _isChangingPassphrase
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Change'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
