import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show authServiceProvider, syncServiceProvider;
import 'package:phpoc_flutter/services/auth_service.dart';

/// Sync — sync status, manual trigger, pending count.
///
/// Displays sync state (Ready/Offline/Syncing/Error), a "Sync Now" button,
/// pending entry count, and a commit-entry placeholder for Phase 7.
class SyncScreen extends ConsumerStatefulWidget {
  const SyncScreen({super.key});

  @override
  ConsumerState<SyncScreen> createState() => _SyncScreenState();
}

class _SyncScreenState extends ConsumerState<SyncScreen> {
  SyncCheckResult _status = SyncCheckResult.offline;
  int _pendingCount = 0;
  int? _lastSyncAt;
  String? _errorMessage;
  bool _isSyncing = false;

  @override
  void initState() {
    super.initState();
    _refreshStatus();
  }

  Future<void> _refreshStatus() async {
    final sync = ref.read(syncServiceProvider);
    setState(() {
      if (!sync.isRemoteAvailable) {
        _status = SyncCheckResult.offline;
      } else {
        _status = SyncCheckResult.ready;
      }
    });
  }

  Future<void> _syncNow() async {
    setState(() {
      _isSyncing = true;
      _errorMessage = null;
    });

    try {
      final sync = ref.read(syncServiceProvider);
      // Sync is a multi-step operation handled by SyncService
      final result = await sync.checkAndSync();

      if (!mounted) return;

      if (result == SyncCheckResult.reauthNeeded) {
        // Instead of showing an error, prompt for passphrase
        setState(() => _isSyncing = false);
        final reauthOk = await _promptReauth();
        if (reauthOk == true && mounted) {
          // Retry sync after successful re-auth
          _syncNow();
        }
        return;
      }

      setState(() {
        _status = result;
        _isSyncing = false;
        if (result == SyncCheckResult.ready) {
          _lastSyncAt = DateTime.now().millisecondsSinceEpoch;
        } else if (result == SyncCheckResult.reauthNeeded) {
          _errorMessage = 'Re-authentication required';
        } else if (result == SyncCheckResult.genesisMismatch) {
          _errorMessage = 'Genesis mismatch — cannot sync';
        } else {
          _errorMessage = 'Sync failed — could not reach remote';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isSyncing = false;
        _status = SyncCheckResult.offline;
        _errorMessage = 'Sync error: $e';
      });
    }
  }

  Future<bool> _promptReauth() async {
    final controller = TextEditingController();
    String? errorMsg;

    final result = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Re-authentication Required'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Enter your passphrase to unlock sync. Your master key has '
                'been cleared from memory for security.',
              ),
              const SizedBox(height: 12),
              TextField(
                controller: controller,
                obscureText: true,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: 'Passphrase',
                  border: const OutlineInputBorder(),
                  errorText: errorMsg,
                ),
                onSubmitted: (value) {
                  if (value.isNotEmpty) Navigator.of(ctx).pop(value);
                },
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                final v = controller.text.trim();
                if (v.isNotEmpty) Navigator.of(ctx).pop(v);
              },
              child: const Text('Unlock'),
            ),
          ],
        ),
      ),
    );

    controller.dispose();

    if (result == null) return false; // User canceled

    try {
      final auth = ref.read(authServiceProvider);
      await auth.reauthenticate(result);
      return true;
    } on AuthException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message)),
        );
      }
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sync')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Status indicator card
          _buildStatusCard(),
          const SizedBox(height: 16),
          // Sync Now button
          SizedBox(
            width: double.infinity,
            height: 48,
            child: FilledButton.icon(
              onPressed: _isSyncing ? null : _syncNow,
              icon: _isSyncing
                  ? const SizedBox(
                      width: 20, height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync),
              label: Text(_isSyncing ? 'Syncing…' : 'Sync Now'),
            ),
          ),
          const SizedBox(height: 8),
          // Error message with retry
          if (_errorMessage != null) _buildErrorCard(),
          const SizedBox(height: 24),
          // Last sync timestamp
          if (_lastSyncAt != null) ...[
            _buildInfoRow(
              Icons.access_time,
              'Last synced: ${FormatUtils.dateTime(DateTime.fromMillisecondsSinceEpoch(_lastSyncAt!))}',
            ),
            const SizedBox(height: 8),
          ],
          // Pending entries
          _buildInfoRow(
            Icons.cloud_upload_outlined,
            'Pending entries: $_pendingCount',
          ),
          const SizedBox(height: 24),
          // Commit-entry placeholder (Phase 7)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Commit to Ledger',
                      style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  Text(
                    'Coming in a future update',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStatusCard() {
    final (statusText, icon, color) = switch (_status) {
      SyncCheckResult.ready => (
          'Ready',
          Icons.check_circle,
          Colors.green,
        ),
      SyncCheckResult.offline => (
          'Offline',
          Icons.cloud_off,
          Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      SyncCheckResult.reauthNeeded => (
          'Re-auth Required',
          Icons.lock_outline,
          Theme.of(context).colorScheme.error,
        ),
      SyncCheckResult.genesisMismatch => (
          'Genesis Mismatch',
          Icons.warning_amber,
          Theme.of(context).colorScheme.error,
        ),
    };

    // Override: show "Syncing…" while in progress
    final displayText = _isSyncing ? 'Syncing…' : statusText;
    final displayIcon = _isSyncing ? Icons.sync : icon;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(displayIcon, size: 32, color: color),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Sync Status',
                    style: Theme.of(context).textTheme.bodySmall),
                Text(
                  displayText,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: color,
                        fontWeight: FontWeight.bold,
                      ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoRow(IconData icon, String text) {
    return Row(
      children: [
        Icon(icon, size: 16,
            color: Theme.of(context).colorScheme.onSurfaceVariant),
        const SizedBox(width: 8),
        Text(text, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }

  Widget _buildErrorCard() {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.error_outline,
                    color: Theme.of(context).colorScheme.error),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _errorMessage!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: _syncNow,
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Retry'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
