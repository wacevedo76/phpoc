import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show onboardingServiceProvider;
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// Onboarding screen — first-time setup.
///
/// Top-level: three cards for Create New Ledger, Import from Recovery Seed,
/// and Connect to Worker. Each expands into a sub-flow.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

enum _OnboardingStep { main, createPassphrase, seedDisplay, importSeed, workerConnect, restoreCloud }

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  _OnboardingStep _step = _OnboardingStep.main;

  final _passphraseController = TextEditingController();
  final _seedController = TextEditingController();
  final _workerUrlController = TextEditingController();
  final _workerApiKeyController = TextEditingController();

  bool _obscurePassphrase = true;
  bool _seedAcknowledged = false;
  bool _isLoading = false;
  String? _errorMessage;
  String? _displayedSeed;

  @override
  void dispose() {
    _passphraseController.dispose();
    _seedController.dispose();
    _workerUrlController.dispose();
    _workerApiKeyController.dispose();
    super.dispose();
  }

  void _goBack() {
    setState(() {
      _step = _OnboardingStep.main;
      _errorMessage = null;
      _seedAcknowledged = false;
      _displayedSeed = null;
    });
  }

  // ── Create New Ledger ────────────────────────────────────────

  Future<void> _startCreateFlow() async {
    final confirmed = await _confirmWipeExistingData();
    if (!mounted) return;
    if (confirmed) {
      setState(() {
        _passphraseController.clear();
        _errorMessage = null;
        _step = _OnboardingStep.createPassphrase;
      });
    }
  }

  Future<void> _createLedger() async {
    final passphrase = _passphraseController.text.trim();

    if (passphrase.length < 8) {
      setState(() => _errorMessage = 'Passphrase must be at least 8 characters');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      final seed = await onboarding.createNewLedger(passphrase, wipeExisting: true);

      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _displayedSeed = seed;
        _step = _OnboardingStep.seedDisplay;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      _handleServiceError(e, 'Failed to create ledger');
    }
  }

  void _finishCreateFlow() {
    setState(() => _isLoading = false);
    ref.read(appLifecycleProvider.notifier).goToAuth();
  }

  // ── Import from Seed ─────────────────────────────────────────

  Future<void> _startImportFlow() async {
    final confirmed = await _confirmWipeExistingData();
    if (!mounted) return;
    if (confirmed) {
      setState(() {
        _passphraseController.clear();
        _seedController.clear();
        _errorMessage = null;
        _step = _OnboardingStep.importSeed;
      });
    }
  }

  Future<void> _importFromSeed() async {
    final seed = _seedController.text.trim();
    final passphrase = _passphraseController.text.trim();

    if (seed.isEmpty) {
      setState(() => _errorMessage = 'Please enter your recovery seed');
      return;
    }

    if (passphrase.length < 8) {
      setState(() => _errorMessage = 'Passphrase must be at least 8 characters');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      await onboarding.importFromSeed(seed, passphrase, wipeExisting: true);

      if (!mounted) return;
      setState(() => _isLoading = false);
      ref.read(appLifecycleProvider.notifier).goToAuth();
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      _handleServiceError(e, 'Failed to import');
    }
  }

  // ── Connect to Worker ────────────────────────────────────────

  Future<void> _startWorkerFlow() async {
    setState(() => _step = _OnboardingStep.workerConnect);
  }

  Future<void> _connectWorker() async {
    final url = _workerUrlController.text.trim();
    final apiKey = _workerApiKeyController.text.trim();

    if (url.isEmpty) {
      setState(() => _errorMessage = 'Please enter the Worker URL');
      return;
    }

    // Basic URL validation
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme || !uri.hasAuthority) {
      setState(() => _errorMessage = 'Please enter a valid URL (e.g., https://worker.example.com)');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      await onboarding.connectWorker(url, apiKey);

      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _step = _OnboardingStep.main;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      _handleServiceError(e, 'Failed to connect');
    }
  }

  // ── Restore from Cloud ──────────────────────────────────────

  Future<void> _startRestoreCloudFlow() async {
    final confirmed = await _confirmWipeExistingData();
    if (!mounted) return;
    _passphraseController.clear();
    _seedController.clear();
    _workerUrlController.clear();
    _workerApiKeyController.clear();
    if (confirmed) {
      setState(() {
        _step = _OnboardingStep.restoreCloud;
        _errorMessage = null;
        _isLoading = false;
      });
    }
  }

  Future<void> _restoreFromCloud() async {
    final seed = _seedController.text.trim();
    final passphrase = _passphraseController.text.trim();
    final url = _workerUrlController.text.trim();
    final apiKey = _workerApiKeyController.text.trim();

    // Validate seed
    if (seed.isEmpty) {
      setState(() => _errorMessage = 'Please enter your recovery seed');
      return;
    }

    // Validate passphrase
    if (passphrase.length < 8) {
      setState(
          () => _errorMessage = 'Passphrase must be at least 8 characters');
      return;
    }

    // Validate Worker URL
    if (url.isEmpty) {
      setState(() => _errorMessage = 'Please enter the Worker URL');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final onboarding = ref.read(onboardingServiceProvider);
      final result = await onboarding.restoreFromCloud(
          seed, passphrase, url, apiKey, wipeExisting: true);

      if (!mounted) return;
      setState(() => _isLoading = false);

      if (result.success) {
        ref.read(appLifecycleProvider.notifier).goToAuth();
      } else {
        // Surface the first error to the user
        final message = result.errors.isNotEmpty
            ? result.errors.first
            : 'Restore failed — no blocks were pulled.';
        setState(() => _errorMessage = message);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoading = false);
      _handleServiceError(e, 'Failed to restore');
    }
  }

  // ── Import from File ───────────────────────────────────────

  Future<void> _pickSeedFile() async {
    try {
      final result = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['txt'],
        withReadStream: true,
      );

      if (result == null || result.files.isEmpty) return; // User canceled

      final file = result.files.first;
      if (file.size > 1024) {
        // 1 KiB limit — seeds are ~44 chars of base64
        setState(() => _errorMessage = 'File is too large. Expected a small text file with a recovery seed.');
        return;
      }

      final stream = file.readStream;
      if (stream == null) {
        setState(() => _errorMessage = 'Could not read file.');
        return;
      }

      final chunks = await stream.toList();
      final bytes = chunks.expand((chunk) => chunk).toList();
      final content = utf8.decode(bytes).trim();

      if (content.isEmpty) {
        setState(() => _errorMessage = 'File is empty.');
        return;
      }

      setState(() {
        _seedController.text = content;
        _errorMessage = null;
      });
    } catch (e) {
      setState(() => _errorMessage = 'Failed to read file: $e');
    }
  }

  /// Show a confirmation dialog warning that existing data will be wiped.
  ///
  /// Returns true if the user confirms the wipe, false if they cancel.
  /// If no existing data is found, returns true immediately (no dialog).
  Future<bool> _confirmWipeExistingData() async {
    final onboarding = ref.read(onboardingServiceProvider);
    final hasData = await onboarding.hasExistingData();
    if (!hasData) return true; // No existing data — proceed without dialog

    if (!mounted) return false;

    return await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Existing Data Detected'),
        content: const Text(
          'A ledger already exists on this device. Creating or importing '
          'a new ledger will permanently delete all existing data including '
          'entries, history, and sync configuration.\n\n'
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
            child: const Text('Delete & Continue'),
          ),
        ],
      ),
    ).then((v) => v ?? false);
  }

  /// Centralized error handling for service calls.
  ///
  /// Sets [_errorMessage] from the exception. Shows a dialog for
  /// [LedgerExistsException] (data guard violations). All exceptions
  /// result in [_isLoading] = false.
  void _handleServiceError(Object e, String fallbackMessage) {
    _errorMessage = e is FormatException ? e.message : '$fallbackMessage: $e';
  }

  // ── Build ────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Welcome to PH Ledger'),
        leading: _step != _OnboardingStep.main
            ? IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: _goBack,
              )
            : null,
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _buildStep(),
        ),
      ),
    );
  }

  Widget _buildStep() {
    switch (_step) {
      case _OnboardingStep.main:
        return _buildMainOptions();
      case _OnboardingStep.createPassphrase:
        return _buildCreatePassphrase();
      case _OnboardingStep.seedDisplay:
        return _buildSeedDisplay();
      case _OnboardingStep.importSeed:
        return _buildImportSeed();
      case _OnboardingStep.workerConnect:
        return _buildWorkerConnect();
      case _OnboardingStep.restoreCloud:
        return _buildRestoreCloud();
    }
  }

  // ── Main Options ─────────────────────────────────────────────

  Widget _buildMainOptions() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(
          Icons.auto_stories,
          size: 72,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: 16),
        Text(
          'Let\'s get started',
          style: Theme.of(context).textTheme.headlineSmall,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          'Choose how you want to set up PH Ledger',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 32),
        // Create New Ledger
        Card(
          child: ListTile(
            leading: const Icon(Icons.add_circle_outline, size: 32),
            title: const Text('Create New Ledger'),
            subtitle: const Text('Start fresh with a new encrypted ledger'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _startCreateFlow,
          ),
        ),
        const SizedBox(height: 8),
        // Import from Recovery Seed
        Card(
          child: ListTile(
            leading: const Icon(Icons.download, size: 32),
            title: const Text('Import from Recovery Seed'),
            subtitle: const Text('Restore your ledger from a seed backup'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _startImportFlow,
          ),
        ),
        const SizedBox(height: 8),
        // Connect to Worker
        Card(
          child: ListTile(
            leading: const Icon(Icons.cloud_outlined, size: 32),
            title: const Text('Connect to Worker'),
            subtitle: const Text('Set up remote sync (optional)'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _startWorkerFlow,
          ),
        ),
        const SizedBox(height: 8),
        // Restore from Cloud
        Card(
          child: ListTile(
            leading: const Icon(Icons.cloud_download_outlined, size: 32),
            title: const Text('Restore from Cloud'),
            subtitle: const Text('Restore your ledger from seed and cloud backup'),
            trailing: const Icon(Icons.chevron_right),
            onTap: _startRestoreCloudFlow,
          ),
        ),
      ],
    );
  }

  // ── Create: Passphrase ───────────────────────────────────────

  Widget _buildCreatePassphrase() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Create a Passphrase',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          'Choose a strong passphrase to protect your ledger. '
          'You will need this every time you unlock the app.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _passphraseController,
          obscureText: _obscurePassphrase,
          autofocus: true,
          decoration: InputDecoration(
            labelText: 'Passphrase',
            hintText: 'At least 8 characters',
            prefixIcon: const Icon(Icons.key),
            errorText: _errorMessage,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _isLoading ? null : _createLedger,
            child: _isLoading
                ? const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Create'),
          ),
        ),
      ],
    );
  }

  // ── Create: Seed Display ─────────────────────────────────────

  Widget _buildSeedDisplay() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.check_circle, size: 64, color: Colors.green),
        const SizedBox(height: 16),
        Text(
          'Your Recovery Seed',
          style: Theme.of(context).textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          'Save this seed in a secure location. You will need it to '
          'recover your ledger if you lose your device or forget your passphrase.',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
          ),
          child: SelectableText(
            _displayedSeed ?? '',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                ),
            textAlign: TextAlign.center,
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            IconButton(
              icon: const Icon(Icons.copy),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: _displayedSeed ?? ''));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Seed copied to clipboard')),
                );
              },
              tooltip: 'Copy seed',
            ),
            const SizedBox(width: 8),
            Text('Copy to clipboard', style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        const SizedBox(height: 24),
        CheckboxListTile(
          value: _seedAcknowledged,
          onChanged: (v) => setState(() => _seedAcknowledged = v ?? false),
          title: const Text('I have saved my recovery seed in a safe place'),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _seedAcknowledged ? _finishCreateFlow : null,
            child: const Text('Continue'),
          ),
        ),
      ],
    );
  }

  // ── Import Seed ──────────────────────────────────────────────

  Widget _buildImportSeed() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Import from Recovery Seed',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          'Enter your recovery seed and choose a passphrase to restore your ledger.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 24),
        // Import from File button
        OutlinedButton.icon(
          onPressed: _isLoading ? null : _pickSeedFile,
          icon: const Icon(Icons.file_open),
          label: const Text('Import from File'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _seedController,
          maxLines: 2,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'Recovery Seed',
            hintText: 'Paste your base64 recovery seed',
            prefixIcon: Icon(Icons.vpn_key),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _passphraseController,
          obscureText: _obscurePassphrase,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: InputDecoration(
            labelText: 'New Passphrase',
            hintText: 'At least 8 characters',
            prefixIcon: const Icon(Icons.key),
            errorText: _errorMessage,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _isLoading ? null : _importFromSeed,
            child: _isLoading
                ? const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Import'),
          ),
        ),
      ],
    );
  }

  // ── Connect to Worker ────────────────────────────────────────

  Widget _buildWorkerConnect() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Connect to Worker',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          'Configure a Cloudflare Worker for remote sync. '
          'You can skip this and set it up later in Settings.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _workerUrlController,
          autofocus: true,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'Worker URL',
            hintText: 'https://worker.example.com',
            prefixIcon: Icon(Icons.link),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _workerApiKeyController,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'API Key',
            hintText: 'Your Worker API key',
            prefixIcon: Icon(Icons.vpn_key),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        if (_errorMessage != null) ...[
          Text(
            _errorMessage!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 16),
        ],
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _isLoading ? null : _connectWorker,
            child: _isLoading
                ? const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Connect'),
          ),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton(
            onPressed: _goBack,
            child: const Text('Skip for now'),
          ),
        ),
      ],
    );
  }

  // ── Restore from Cloud Form ─────────────────────────────────

  Widget _buildRestoreCloud() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Restore from Cloud',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          'Enter your recovery seed, passphrase, and Worker details to '
          'restore your ledger from the cloud.',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _seedController,
          autofocus: true,
          enabled: !_isLoading,
          maxLines: 2,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'Recovery Seed',
            hintText: 'Paste your base64 recovery seed',
            prefixIcon: Icon(Icons.vpn_key),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _passphraseController,
          obscureText: _obscurePassphrase,
          enabled: !_isLoading,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'Passphrase',
            hintText: 'At least 8 characters',
            prefixIcon: Icon(Icons.key),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _workerUrlController,
          enabled: !_isLoading,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'Worker URL',
            hintText: 'https://worker.example.com',
            prefixIcon: Icon(Icons.link),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _workerApiKeyController,
          enabled: !_isLoading,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            labelText: 'API Key',
            hintText: 'Your Worker API key',
            prefixIcon: Icon(Icons.vpn_key),
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 16),
        if (_errorMessage != null) ...[
          Text(
            _errorMessage!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 16),
        ],
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _isLoading ? null : _restoreFromCloud,
            child: _isLoading
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Restore'),
          ),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton(
            onPressed: _isLoading ? null : _goBack,
            child: const Text('Cancel'),
          ),
        ),
      ],
    );
  }
}
