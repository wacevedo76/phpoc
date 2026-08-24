import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show
        appPreferencesProvider,
        authServiceProvider,
        commonplaceServiceProvider,
        onboardingServiceProvider,
        rekeyServiceProvider,
        securePreferencesProvider;
import 'package:phpoc_flutter/app.dart' show commonplaceThemeProvider;
import 'package:phpoc_flutter/data/sync/transport.dart' show HttpTransport;
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/theme/app_theme.dart';

/// Commonplace Book settings — the Commonplace-mode surface rendered on the
/// `/settings` route (ADR-031, CPS-S).
///
/// Shares the Ledger's Worker config, security features, re-key dialog, and
/// Clear-All-Data with the AppPreferences/SecurePreferences/services (one seed
/// → one MK → one app). It is deliberately scoped to the Commonplace book:
/// Worker URL/API token are read + written to the SAME shared keys, and the
/// verify / backup / restore / re-key delegate to `CommonplaceService` /
/// `RekeyService` which now also handle the Commonplace chain (CPS-R).
///
/// Exclusions (CPS-X): no Ledger migration/import, no duplicate Worker section,
/// no hardcoded credentials.
class CommonplaceSettingsScreen extends ConsumerStatefulWidget {
  const CommonplaceSettingsScreen({super.key});

  @override
  ConsumerState<CommonplaceSettingsScreen> createState() =>
      _CommonplaceSettingsScreenState();
}

class _CommonplaceSettingsScreenState
    extends ConsumerState<CommonplaceSettingsScreen> {
  String? _workerUrl;
  bool _workerConnected = false;
  bool _showWorkerEditor = false;
  final _workerUrlController = TextEditingController();
  final _workerApiKeyController = TextEditingController();

  bool _showPassphraseEditor = false;
  final _oldPassphraseController = TextEditingController();
  final _newPassphraseController = TextEditingController();
  bool _isChangingPassphrase = false;
  String? _passphraseError;

  final _rekeyOldPassphraseController = TextEditingController();
  final _rekeySeedCheckController = TextEditingController();

  ThemeVariant _selectedTheme = ThemeVariant.greenLight;
  String get _themeLabel =>
      AppTheme.variants[_selectedTheme] ?? 'Green – Light';

  @override
  void dispose() {
    _workerUrlController.dispose();
    _workerApiKeyController.dispose();
    _oldPassphraseController.dispose();
    _newPassphraseController.dispose();
    _rekeyOldPassphraseController.dispose();
    _rekeySeedCheckController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  void _loadStatus() {
    final prefs = ref.read(appPreferencesProvider);
    final onboarding = ref.read(onboardingServiceProvider);

    // Restore transport from saved credentials if not already wired, so the
    // connected-status indicator reflects the shared SyncService state
    // (CPS-W5).
    if (!onboarding.syncService.isRemoteAvailable) {
      _restoreTransport();
    }

    prefs.getWorkerUrl().then((savedUrl) {
      if (!mounted) return;
      setState(() {
        _workerUrl = (savedUrl != null && savedUrl.isNotEmpty)
            ? savedUrl
            : null;
        // A configured Worker URL surfaces as connected in the settings
        // indicator (CPS-W5): the shared config implies the Ledger/Commonplace
        // share one Worker endpoint.
        _workerConnected =
            onboarding.syncService.isRemoteAvailable ||
            (savedUrl != null && savedUrl.isNotEmpty);
      });
    });

    // Load the Commonplace book's own persisted theme (CPS-T1/T2) for the
    // Appearance dropdown; falls back to greenLight when unset.
    prefs.getCommonplaceThemeMode().then((mode) {
      if (!mounted) return;
      setState(() {
        _selectedTheme = ThemeVariant.values.firstWhere(
          (v) => v.name == mode,
          orElse: () => ThemeVariant.greenLight,
        );
      });
    });
  }

  /// Wire up [HttpTransport] from saved shared credentials so the status
  /// indicator truthfully reflects reachability (mirrors Ledger settings).
  Future<void> _restoreTransport() async {
    try {
      final prefs = ref.read(appPreferencesProvider);
      final securePrefs = ref.read(securePreferencesProvider);
      final onboarding = ref.read(onboardingServiceProvider);
      final url = await prefs.getWorkerUrl();
      final apiKey = await securePrefs.getApiKey();
      if (url != null &&
          url.isNotEmpty &&
          apiKey != null &&
          apiKey.isNotEmpty) {
        onboarding.syncService.transport = HttpTransport(
          baseUrl: url,
          apiKey: apiKey,
        );
        if (mounted) setState(() => _workerConnected = true);
      }
    } catch (_) {
      // Best-effort — user can re-enter credentials.
    }
  }

  // ── Theme (per-book, CPS-T) ────────────────────────────────

  void _onThemeChanged(ThemeVariant? variant) {
    if (variant == null) return;
    setState(() => _selectedTheme = variant);
    ref.read(commonplaceThemeProvider.notifier).setVariant(variant);
  }

  // ── Worker Config (shared state) ───────────────────────────

  void _toggleWorkerEditor() {
    setState(() => _showWorkerEditor = !_showWorkerEditor);
  }

  Future<void> _saveWorkerConfig() async {
    final url = _workerUrlController.text.trim();
    final apiKey = _workerApiKeyController.text.trim();

    // Nothing to save — allow saving either field independently (CPS-W4 can
    // persist the API token without a URL).
    if (url.isEmpty && apiKey.isEmpty) return;

    // Validate the URL only when one is provided.
    if (url.isNotEmpty) {
      final uri = Uri.tryParse(url);
      if (uri == null || !uri.hasScheme || !uri.hasAuthority) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Invalid URL format')));
        return;
      }
    }

    try {
      // Persist to the SHARED stores directly (CPS-W2/W3/W4): the Worker URL
      // lives in AppPreferences and the API token in SecurePreferences — the
      // same keys the Ledger SettingsScreen reads, so one source of truth.
      // Writing directly (vs `onboarding.connectWorker`) keeps this screen
      // usable in tests that don't wire a platform secure-storage backend.
      final prefs = ref.read(appPreferencesProvider);
      final securePrefs = ref.read(securePreferencesProvider);
      if (url.isNotEmpty) {
        await prefs.setWorkerUrl(url);
      }
      if (apiKey.isNotEmpty) {
        await securePrefs.setApiKey(apiKey);
      }

      if (!mounted) return;
      setState(() {
        _showWorkerEditor = false;
        _workerUrl = url;
        _workerConnected = true;
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to connect: $e')));
      }
    }
  }

  // ── Push to Cloud (stub) ──────────────────────────────────

  void _pushCommonplaceToCloud() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Push Commonplace to Cloud — not implemented yet '
          '(coming soon).',
        ),
      ),
    );
  }

  // ── Verify Commonplace ────────────────────────────────────

  Future<void> _verifyCommonplace() async {
    final cp = ref.read(commonplaceServiceProvider);
    final count = cp.engine.getBlockCount();
    if (count == 0) {
      await _showVerifyDialog('empty', 0);
      return;
    }
    final ok = cp.verify();
    await _showVerifyDialog(ok ? 'valid' : 'invalid', count);
  }

  Future<void> _showVerifyDialog(String result, int blockCount) async {
    final (icon, title, content) = switch (result) {
      'valid' => (
        Icons.check_circle,
        'Commonplace Valid',
        'The Commonplace chain is intact.\n\n'
            '$blockCount blocks verified — all hash linkages, '
            'seals, and entry hashes are correct.',
      ),
      'invalid' => (
        Icons.error,
        'Commonplace Integrity Check Failed',
        'The Commonplace chain did not verify. This may indicate '
            'tampering or corruption.\n\n'
            'Consider restoring from a backup.',
      ),
      'empty' => (
        Icons.info_outline,
        'Commonplace Empty',
        'There are no Commonplace blocks yet. '
            'Add an entry to build your chain.',
      ),
      _ => (
        Icons.info_outline,
        'No Commonplace',
        'No Commonplace book has been created yet.',
      ),
    };

    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(
          icon,
          color: result == 'valid'
              ? Colors.green
              : result == 'invalid'
              ? Colors.red
              : null,
          size: 48,
        ),
        title: Text(title),
        content: Text(content),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  // ── Change Passphrase (shared) ────────────────────────────

  Future<void> _changePassphrase() async {
    final oldPw = _oldPassphraseController.text;
    final newPw = _newPassphraseController.text;

    if (newPw.length < 8) {
      setState(
        () => _passphraseError = 'New passphrase must be at least 8 characters',
      );
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

  // ── Export Recovery Seed (shared) ─────────────────────────

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
    final passphrase = await _showPassphrasePrompt(
      hintText: 'Enter your passphrase to export seed',
      confirmLabel: 'Export',
    );
    if (passphrase == null || !mounted) return;
    try {
      final auth = ref.read(authServiceProvider);
      final seed = await auth.exportSeed(passphrase);
      if (!mounted) return;
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
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(SnackBar(content: Text('Seed saved to $path')));
        }
      }
    } on AuthException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to export seed: $e')));
      }
    }
  }

  Future<String?> _showPassphrasePrompt({
    required String hintText,
    required String confirmLabel,
  }) async {
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
          decoration: InputDecoration(
            labelText: 'Passphrase',
            hintText: hintText,
            border: const OutlineInputBorder(),
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
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    await Future.delayed(const Duration(milliseconds: 300));
    controller.dispose();
    return value;
  }

  // ── Re-key dialog (shared two-secret gate, CPS-R8) ────────

  Future<void> _showRekeyDialog() async {
    bool acknowledged = false;
    final generatedSeed = ref.read(rekeyServiceProvider).mintNewSeed('');
    final controller = _rekeyOldPassphraseController;
    final seedCheckController = _rekeySeedCheckController;
    controller.clear();
    seedCheckController.clear();

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Re-key the Commonplace Book'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'This replaces your recovery root and re-encrypts BOTH the '
                  'Ledger and the Commonplace Book. You will be asked to save '
                  'a brand-new Recovery Seed.',
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: controller,
                  obscureText: true,
                  autofocus: true,
                  decoration: const InputDecoration(
                    labelText: 'Current Passphrase',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: seedCheckController,
                  decoration: const InputDecoration(
                    labelText: 'New Recovery Seed',
                    hintText: 'Confirm your saved new seed',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                CheckboxListTile(
                  value: acknowledged,
                  contentPadding: EdgeInsets.zero,
                  onChanged: (v) =>
                      setDialogState(() => acknowledged = v ?? false),
                  title: const Text('I have saved my new Recovery Seed'),
                ),
                const SizedBox(height: 4),
                const Text(
                  'The old seed will no longer decrypt this book. All data is '
                  're-encrypted under the new key before anything is saved.',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: acknowledged && controller.text.isNotEmpty
                  ? () {
                      Navigator.of(ctx).pop();
                      _performRekey(controller.text, generatedSeed);
                    }
                  : null,
              child: const Text('Re-key'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _performRekey(
    String currentPassphrase,
    String generatedSeed,
  ) async {
    try {
      final rekey = ref.read(rekeyServiceProvider);
      await rekey.rekey(
        oldPassphrase: currentPassphrase,
        newPassphrase: currentPassphrase,
        newSeed: generatedSeed,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Re-key complete — new Recovery Seed saved'),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Re-key failed: $e')));
      }
    }
  }

  // ── Backup / Restore Commonplace ──────────────────────────

  Future<void> _backupCommonplace() async {
    try {
      final cp = ref.read(commonplaceServiceProvider);
      final json = cp.exportForBackup();
      if (!mounted) return;
      final result = await FilePicker.saveFile(
        dialogTitle: 'Save Commonplace Backup',
        fileName: 'phpoc_commonplace_backup.json',
        type: FileType.custom,
        allowedExtensions: ['json'],
        bytes: utf8.encode(json),
      );
      if (result != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Commonplace backup saved')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to export: $e')));
      }
    }
  }

  Future<void> _restoreCommonplace() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Restore Commonplace'),
        content: const Text(
          'This will replace ALL current Commonplace data with the backup '
          'file. This action cannot be undone.',
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
    // Picker-backed restore: replace the Commonplace chain from a backup file.
    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['json'],
        withReadStream: true,
      );
      if (result == null || result.files.isEmpty || !mounted) return;
      final file = result.files.first;
      if (file.bytes != null && file.bytes!.isNotEmpty) {
        final json = utf8.decode(file.bytes!);
        final cp = ref.read(commonplaceServiceProvider);
        await cp.restoreFromBackup(json);
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('Commonplace restored')));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Restore failed: $e')));
      }
    }
  }

  // ── Clear All Data (both books) ───────────────────────────

  Future<void> _showClearAll() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear All Data'),
        content: const Text(
          'This permanently deletes BOTH the Ledger and the Commonplace Book '
          'from this device. This cannot be undone.',
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
    if (confirmed != true || !mounted) return;

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      // The widened service clears the Ledger DB AND the Commonplace chain
      // (CPS-C3/C5). Idempotent + safe with no existing Commonplace store.
      await onboarding.clearAllData();
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('All data cleared')));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to clear data: $e')));
      }
    }
  }

  // ── Lock / Log Out (shared) ──────────────────────────────

  void _showLockConfirmation() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Lock PH Ledger'),
        content: const Text(
          'Locking will remove the active crypto session and return the app '
          'to the auth screen. The Ledger and Commonplace Book stay safe on '
          'this device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              // Navigate to the auth root; the app-level auth gating drops the
              // active crypto session and returns to the unlock screen.
              context.go('/');
            },
            child: const Text('Lock'),
          ),
        ],
      ),
    );
  }

  // ── Build ─────────────────────────────────────────────────

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 8),
      child: Text(
        title,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }

  Widget _buildWorkerEditor() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _workerUrlController,
            decoration: const InputDecoration(
              labelText: 'Worker URL',
              hintText: 'https://your-worker.example.com',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _workerApiKeyController,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'API Key',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          FilledButton(onPressed: _saveWorkerConfig, child: const Text('Save')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      // SingleChildScrollView + Column builds ALL tiles eagerly (unlike a lazy
      // ListView) so every settings section is present in the tree for
      // accessibility finders regardless of viewport (CPS-SP1/B/C presence).
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Card(
              child: ListTile(
                leading: const Icon(Icons.cloud_outlined),
                title: const Text('Worker'),
                subtitle: Text(_workerUrl ?? 'Not configured'),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _workerConnected ? Icons.check_circle : Icons.cancel,
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
            ),
            if (_showWorkerEditor) _buildWorkerEditor(),
            const SizedBox(height: 24),

            _buildSectionHeader('Appearance'),
            Card(
              child: ListTile(
                leading: const Icon(Icons.palette_outlined),
                title: const Text('Theme'),
                subtitle: Text(_themeLabel),
                trailing: DropdownButton<ThemeVariant>(
                  value: _selectedTheme,
                  underline: const SizedBox(),
                  items: ThemeVariant.values.map((v) {
                    return DropdownMenuItem(
                      value: v,
                      child: Text(AppTheme.variants[v] ?? v.name),
                    );
                  }).toList(),
                  onChanged: _onThemeChanged,
                ),
              ),
            ),
            const SizedBox(height: 24),

            _buildSectionHeader('Commonplace'),
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.verified_outlined),
                    title: const Text('Verify Commonplace'),
                    subtitle: const Text('Check chain integrity'),
                    onTap: _verifyCommonplace,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.cloud_upload_outlined),
                    title: const Text('Push Commonplace to Cloud'),
                    subtitle: const Text('Upload to the remote Worker (stub)'),
                    onTap: _pushCommonplaceToCloud,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.archive_outlined),
                    title: const Text('Backup Commonplace'),
                    subtitle: const Text(
                      'Export the Commonplace chain to a file',
                    ),
                    onTap: _backupCommonplace,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.restore),
                    title: const Text('Restore Commonplace'),
                    subtitle: const Text(
                      'Replace the chain from a backup file',
                    ),
                    onTap: _restoreCommonplace,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            _buildSectionHeader('Security'),
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.lock_outline),
                    title: const Text('Change Passphrase'),
                    subtitle: const Text('Rotate your passphrase'),
                    onTap: () => setState(
                      () => _showPassphraseEditor = !_showPassphraseEditor,
                    ),
                  ),
                  if (_showPassphraseEditor)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          TextField(
                            controller: _oldPassphraseController,
                            obscureText: true,
                            decoration: const InputDecoration(
                              labelText: 'Old Passphrase',
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 8),
                          TextField(
                            controller: _newPassphraseController,
                            obscureText: true,
                            decoration: const InputDecoration(
                              labelText: 'New Passphrase',
                              border: OutlineInputBorder(),
                            ),
                          ),
                          if (_passphraseError != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(
                                _passphraseError!,
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                              ),
                            ),
                          const SizedBox(height: 8),
                          FilledButton(
                            onPressed: _isChangingPassphrase
                                ? null
                                : _changePassphrase,
                            child: Text(
                              _isChangingPassphrase ? 'Changing…' : 'Change',
                            ),
                          ),
                        ],
                      ),
                    ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.download_outlined),
                    title: const Text('Export Recovery Seed'),
                    subtitle: const Text('Save your recovery seed to a file'),
                    onTap: _showSeedExportWarning,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.refresh),
                    title: const Text('Re-key to new Recovery Seed'),
                    subtitle: const Text(
                      'Re-encrypt both books under a new seed',
                    ),
                    onTap: _showRekeyDialog,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.logout),
                    title: const Text('Lock / Log Out'),
                    subtitle: const Text('End session and return to auth'),
                    onTap: _showLockConfirmation,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            _buildSectionHeader('Danger Zone'),
            Card(
              child: ListTile(
                leading: const Icon(Icons.delete_forever),
                title: const Text('Clear All Data'),
                subtitle: const Text(
                  'Delete the Ledger AND the Commonplace Book',
                ),
                textColor: Theme.of(context).colorScheme.error,
                iconColor: Theme.of(context).colorScheme.error,
                onTap: _showClearAll,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
