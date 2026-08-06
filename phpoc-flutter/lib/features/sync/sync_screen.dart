import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/models/push_result.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show authServiceProvider, ledgerPushServiceProvider, syncServiceProvider;
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// Sync — uncommitted tasks, pending count, manual sync, thin status bar.
///
/// Row-level staging overhaul: unified "Sync" button that commits all ended
/// entries, pushes ledger blocks, and pushes clean staging — all in one tap.
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
  List<Map<String, dynamic>> _uncommittedEntries = [];
  final Set<int> _expandedUncommitted = {};
  bool _committing = false;
  bool _pushing = false;
  final Map<int, _CardEditState> _editStates = {};
  final Set<int> _saving = {};

  // ── Checkbox selection state (overhaul I2/I3) ────────────

  final Set<int> _selectedIndices = {};
  bool _selectAll = false;

  bool get _canCommit => _uncommittedEntries.isNotEmpty && !_committing;

  Widget _loadingSpinner() => const SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      );

  @override
  void initState() {
    super.initState();
    _refreshStatus();
  }

  Future<void> _refreshStatus() async {
    final sync = ref.read(syncServiceProvider);
    final entries = await sync.getEntries();
    if (!mounted) return;
    setState(() {
      if (!sync.isRemoteAvailable) {
        _status = SyncCheckResult.offline;
      } else {
        _status = SyncCheckResult.ready;
      }
      _pendingCount = entries
          .where((e) => e['is_active'] != true && e['committed'] != true)
          .length;
      _uncommittedEntries = entries
          .where((e) => e['is_active'] != true && e['committed'] != true)
          .toList();
    });
  }

  // ── Unified Sync button (overhaul I4/I5/I6) ──────────────

  Future<void> _unifiedSync() async {
    setState(() => _committing = true);
    // Yield for one frame so the spinner renders before heavy work.
    await Future.delayed(const Duration(milliseconds: 50));
    try {
      final sync = ref.read(syncServiceProvider);

      List<String>? selectedIds;
      if (_selectedIndices.isNotEmpty) {
        selectedIds = _selectedIndices
            .where((i) => i < _uncommittedEntries.length)
            .map((i) => _uncommittedEntries[i]['activity_id'] as String? ?? '')
            .where((id) => id.isNotEmpty)
            .toList();
        if (selectedIds.isEmpty) selectedIds = null;
      }

      final hash = await sync.commitAndSync(selectedIds: selectedIds);

      if (!mounted) return;
      if (hash != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Synced — $hash')),
        );
      }
      await _refreshStatus();
      setState(() {
        _selectedIndices.clear();
        _selectAll = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Sync failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  // ── Select All / Deselect All (overhaul I3) ──────────────

  void _toggleSelectAll() {
    setState(() {
      if (_selectAll) {
        _selectedIndices.clear();
        _selectAll = false;
      } else {
        _selectedIndices.addAll(
          List.generate(_uncommittedEntries.length, (i) => i),
        );
        _selectAll = true;
      }
    });
  }

  Future<void> _commitToLedger() async {
    setState(() => _committing = true);
    // Defer to avoid InheritedElement dependency tracking issues.
    await Future.delayed(Duration.zero);
    if (!mounted) return;
    try {
      final sync = ref.read(syncServiceProvider);
      final hash = await sync.commitEntries();
      if (!mounted) return;
      if (hash != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Committed — $hash')),
        );
      }
      await _refreshStatus();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Commit failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _committing = false);
    }
  }

  /// Renders the "Push Ledger to Cloud" button when a transport is configured.
  Widget _buildPushToCloudButton() {
    final pushSvc = ref.read(ledgerPushServiceProvider);
    if (pushSvc == null) return const SizedBox.shrink();

    return SizedBox(
      width: double.infinity,
      height: 48,
      child: ElevatedButton.icon(
        onPressed: _pushing ? null : _pushToCloud,
        icon: _pushing
            ? _loadingSpinner()
            : const Icon(Icons.cloud_upload),
        label: Text(_pushing ? 'Pushing…' : 'Push Ledger to Cloud'),
      ),
    );
  }

  /// Show a confirmation dialog before pushing — warns that remote data
  /// will be replaced by the local ledger.
  Future<void> _pushToCloud() async {
    final pushSvc = ref.read(ledgerPushServiceProvider);
    if (pushSvc == null) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Overwrite Remote Ledger?'),
        content: const Text(
          'This will erase all existing data on the remote location '
          'and replace it with your local ledger. This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Push'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    setState(() => _pushing = true);
    try {
      final result = await pushSvc.pushAll();
      if (!mounted) return;
      if (result.success) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Pushed ${result.blocksPushed} blocks'
                '${result.hashPrefixDisplay.isNotEmpty ? ' — ${result.hashPrefixDisplay}' : ''}'),
          ),
        );
      } else {
        final reason = result.errors.isNotEmpty
            ? result.errors.first
            : 'Push completed with errors';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Push failed: $reason')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Push failed: $e')),
      );
    } finally {
      if (mounted) setState(() => _pushing = false);
    }
  }

  Future<void> _syncNow() async {
    setState(() {
      _isSyncing = true;
      _errorMessage = null;
    });

    // Defer to next frame to avoid InheritedElement dependency tracking
    // issues (Flutter issue #106546, #106549).
    await Future.delayed(Duration.zero);
    if (!mounted) return;

    try {
      final sync = ref.read(syncServiceProvider);
      final result = await sync.checkAndSync();

      if (!mounted) return;

      if (result == SyncCheckResult.reauthNeeded) {
        setState(() => _isSyncing = false);
        final reauthOk = await _promptReauth();
        if (reauthOk == true && mounted) {
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

      await _refreshStatus();
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

    if (result == null) return false;

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

  // ── Build ──────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sync')),
      body: _buildBody(),
      bottomSheet: _buildStatusBar(),
    );
  }

  Widget _buildBody() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      children: [
        // ── Ready to Commit section with checkboxes (overhaul I2) ──
        if (_uncommittedEntries.isNotEmpty) ...[
          _buildSectionHeader(
            'Ready to Commit',
            Icons.cloud_upload_outlined,
          ),
          // Select All / Deselect All toggle (overhaul I3)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: _toggleSelectAll,
                child: Text(_selectAll ? 'Deselect All' : 'Select All'),
              ),
            ),
          ),
          ..._uncommittedEntries.asMap().entries.map((e) =>
              _buildUncommittedCard(e.value, e.key)),
          const SizedBox(height: 16),
        ],
        _buildPendingCount(),
        const SizedBox(height: 16),
        // Unified Sync button (overhaul I1)
        SizedBox(
          width: double.infinity,
          height: 48,
          child: ElevatedButton.icon(
            onPressed: _canCommit ? _unifiedSync : null,
            icon: _committing ? _loadingSpinner() : const Icon(Icons.sync),
            label: Text(_committing ? 'Syncing…' : 'Sync'),
          ),
        ),
        const SizedBox(height: 16),
        // Legacy commit button (backward compat with old tests)
        SizedBox(
          width: double.infinity,
          height: 48,
          child: ElevatedButton.icon(
            onPressed: _canCommit ? _commitToLedger : null,
            icon: _committing ? _loadingSpinner() : const Icon(Icons.lock_outline),
            label: Text(_committing ? 'Committing…' : 'Commit to Local Ledger'),
          ),
        ),
        const SizedBox(height: 16),
        // Push Ledger to Cloud button (only when transport configured)
        _buildPushToCloudButton(),
        const SizedBox(height: 16),
        // Legacy sync-to-remote button (kept for backward compat)
        SizedBox(
          width: double.infinity,
          height: 48,
          child: FilledButton.icon(
            onPressed: _isSyncing ? null : _syncNow,
            icon: _isSyncing ? _loadingSpinner() : const Icon(Icons.sync),
            label: Text(_isSyncing ? 'Syncing…' : 'Sync to Remote'),
          ),
        ),
        if (_errorMessage != null) ...[
          const SizedBox(height: 8),
          _buildErrorRow(),
        ],
        if (_lastSyncAt != null) ...[
          const SizedBox(height: 16),
          _buildInfoRow(
            Icons.access_time,
            'Last synced: ${FormatUtils.dateTime(DateTime.fromMillisecondsSinceEpoch(_lastSyncAt!))}',
          ),
        ],
      ],
    );
  }

  Widget _buildPendingCount() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_upload_outlined,
              size: 20, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Text(
            '$_pendingCount entry${_pendingCount == 1 ? '' : 's'} pending sync',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const Spacer(),
          if (_pendingCount > 0)
            Icon(Icons.arrow_upward,
                size: 16,
                color: Theme.of(context).colorScheme.onSurfaceVariant),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title, IconData icon) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 6),
          Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: Theme.of(context).colorScheme.primary,
                  fontWeight: FontWeight.bold,
                ),
          ),
        ],
      ),
    );
  }

  // ── Card edit state helpers ────────────────────────────────

  _CardEditState _ensureEditState(int idx) {
    if (!_editStates.containsKey(idx)) {
      final entry = _uncommittedEntries[idx];
      _editStates[idx] = _CardEditState(
        title: entry['title'] as String? ?? '',
        comment: entry['comment'] as String?,
        tags: List<String>.from((entry['tags'] as List?)?.cast<String>() ?? []),
        encryptTitle: entry['title_encrypted'] == true,
        encryptTags: entry['tags_encrypted'] == true,
        encryptComment: entry['comment_encrypted'] == true,
        endEpoch: entry['end_epoch'] as int?,
        pauses: List<Map<String, dynamic>>.from(
            (entry['pauses'] as List?)?.cast<Map>() ?? []),
      );
    }
    return _editStates[idx]!;
  }

  void _disposeEditState(int idx) {
    _editStates.remove(idx)?.dispose();
  }

  Future<void> _saveEntry(int idx) async {
    final es = _editStates[idx];
    if (es == null) return;
    setState(() => _saving.add(idx));
    try {
      final sync = ref.read(syncServiceProvider);
      final entry = _uncommittedEntries[idx];

      // Use activity_id (staging store) or entry_id (local cache) — never
      // the index, because _uncommittedEntries is a filtered subset whose
      // indices don't match getAllRows().
      final id = entry['activity_id'] as String? ??
          entry['entry_id'] as String?;

      final encryptFields = <String>{};
      if (es.encryptTitle) encryptFields.add('title');
      if (es.encryptTags) encryptFields.add('tags');
      if (es.encryptComment) encryptFields.add('comment');

      final fields = <String, dynamic>{
        'title': es.titleController.text,
        'tags': es.tags,
        'pauses': es.pauses,
      };
      if (es.commentController.text.isNotEmpty) {
        fields['comment'] = es.commentController.text;
      } else {
        fields['comment'] = null;
      }
      if (es.endEpoch != null) {
        fields['end_epoch'] = es.endEpoch;
      }

      fields['duration'] = _computeDuration(
        startEpoch: entry['start_epoch'] as int? ?? 0,
        endEpoch: es.endEpoch,
        pauses: es.pauses,
      );

      if (id != null) {
        await sync.modify(id, fields, encryptFields: encryptFields);
      } else {
        // Legacy fallback: index-based for old local cache entries
        final legacyIdx = entry['entry_index'] as int? ?? idx;
        await sync.modify(legacyIdx, fields, encryptFields: encryptFields);
      }

      await _refreshStatus();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Entry saved')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Save failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving.remove(idx));
    }
  }

  Future<void> _confirmDelete(int idx) async {
    final title = _uncommittedEntries[idx]['title'] as String? ?? 'Untitled';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Entry'),
        content: Text('Delete "$title"? This cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(ctx).colorScheme.error,
            ),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await _deleteEntry(idx);
    }
  }

  Future<void> _deleteEntry(int idx) async {
    final entry = _uncommittedEntries[idx];
    final activityId = entry['activity_id'] as String?;
    debugPrint('[SyncScreen] delete idx=$idx activityId=$activityId entry=${entry['title']}');

    setState(() {
      _saving.add(idx);
      _expandedUncommitted.remove(idx);
      _selectedIndices.remove(idx);
      _disposeEditState(idx);
    });
    try {
      final sync = ref.read(syncServiceProvider);
      if (activityId != null && activityId.isNotEmpty) {
        debugPrint('[SyncScreen] calling sync.remove("$activityId")');
        await sync.remove(activityId);
      } else {
        // Fallback: old entry without activity_id — use index
        final entryIndex = entry['entry_index'] as int? ?? idx;
        debugPrint('[SyncScreen] no activityId, using entry_index=$entryIndex');
        await sync.remove(entryIndex);
      }
      debugPrint('[SyncScreen] sync.remove completed, refreshing');
      await _refreshStatus();
      debugPrint('[SyncScreen] refresh done, _uncommittedEntries=${_uncommittedEntries.length}');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Entry deleted')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Delete failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving.remove(idx));
    }
  }

  // ── Uncommitted card (with checkbox for selection) ────────

  Widget _buildUncommittedCard(Map<String, dynamic> entry, int idx) {
    final isExpanded = _expandedUncommitted.contains(idx);
    final es = isExpanded ? _ensureEditState(idx) : null;
    final isSelected = _selectedIndices.contains(idx);

    final title = entry['title'] as String? ?? 'Untitled';
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final storedDurationMs = entry['duration'] as int? ?? 0;
    final tags = (entry['tags'] as List?)?.cast<String>() ?? [];
    final comment = entry['comment'] as String?;
    final pauses =
        (entry['pauses'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);

    final displayDurationMs = isExpanded && es != null
        ? _computeDuration(
            startEpoch: startEpoch,
            endEpoch: es.endEpoch,
            pauses: es.pauses,
          )
        : storedDurationMs;

    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: isSelected ? Colors.blue : Colors.orange,
          width: 2,
        ),
      ),
      child: InkWell(
        onTap: () {
          setState(() {
            if (isExpanded) {
              _expandedUncommitted.remove(idx);
              _disposeEditState(idx);
            } else {
              _expandedUncommitted.add(idx);
              _ensureEditState(idx);
            }
          });
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  // Checkbox for selection (overhaul I2)
                  Checkbox(
                    value: isSelected,
                    onChanged: (v) {
                      setState(() {
                        if (v == true) {
                          _selectedIndices.add(idx);
                        } else {
                          _selectedIndices.remove(idx);
                        }
                        _selectAll =
                            _selectedIndices.length == _uncommittedEntries.length;
                      });
                    },
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.compact,
                  ),
                  Icon(Icons.check_circle_outline,
                      size: 18,
                      color: Theme.of(context).colorScheme.onSurfaceVariant),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                  ),
                  Text(
                    FormatUtils.duration(Duration(milliseconds: displayDurationMs)),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    isExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 20,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                FormatUtils.date(startDt),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: const Color(0xFFFF00FF),
                ),
              ),
              AnimatedCrossFade(
                firstChild: const SizedBox.shrink(),
                secondChild: isExpanded && es != null
                    ? _buildEditDetail(idx, es)
                    : _buildReadOnlyDetail(tags, comment, pauses),
                crossFadeState: isExpanded
                    ? CrossFadeState.showSecond
                    : CrossFadeState.showFirst,
                duration: const Duration(milliseconds: 200),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Read-only detail (collapsed card fallback) ────────────

  Widget _buildReadOnlyDetail(
    List<String> tags,
    String? comment,
    List<Map<String, dynamic>> pauses,
  ) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (tags.isNotEmpty) ...[
            Wrap(
              spacing: 4,
              runSpacing: 2,
              children: tags.map((t) {
                return Chip(
                  label: Text(t, style: const TextStyle(fontSize: 10)),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                );
              }).toList(),
            ),
            const SizedBox(height: 6),
          ],
          if (comment != null && comment.isNotEmpty) ...[
            Text(
              comment,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontStyle: FontStyle.italic,
                  ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 6),
          ],
          if (pauses.isNotEmpty) ...[
            Text(
              'Pauses',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 2),
            ...pauses.map((p) {
              final pStart = p['start_epoch'] as int? ?? 0;
              final pEnd = p['end_epoch'] as int?;
              final pStartDt = DateTime.fromMillisecondsSinceEpoch(pStart);
              final pEndDt =
                  pEnd != null ? DateTime.fromMillisecondsSinceEpoch(pEnd) : null;
              final pDuration = pEndDt != null
                  ? pEndDt.difference(pStartDt)
                  : DateTime.now().difference(pStartDt);
              return Padding(
                padding: const EdgeInsets.only(left: 8, bottom: 2),
                child: Text(
                  pEndDt != null
                      ? '${FormatUtils.time(pStartDt)} \u2013 ${FormatUtils.time(pEndDt)}  (${FormatUtils.duration(pDuration)})'
                      : '${FormatUtils.time(pStartDt)} \u2013 ongoing  (${FormatUtils.duration(pDuration)})',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              );
            }),
          ],
        ],
      ),
    );
  }

  // ── Editable detail (expanded card) ───────────────────────

  Widget _buildEditDetail(int idx, _CardEditState es) {
    final theme = Theme.of(context);
    final isSaving = _saving.contains(idx);

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: es.titleController,
            decoration: InputDecoration(
              labelText: 'Title',
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8)),
            ),
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 10),
          TextField(
            controller: es.commentController,
            decoration: InputDecoration(
              labelText: 'Comment',
              isDense: true,
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8)),
            ),
            style: theme.textTheme.bodySmall,
            maxLines: 2,
            minLines: 1,
          ),
          const SizedBox(height: 10),
          _buildEditTags(idx, es),
          const SizedBox(height: 10),
          _buildEditEndTime(idx, es),
          const SizedBox(height: 10),
          _buildEditPauses(idx, es),
          const SizedBox(height: 12),
          _buildEncryptionToggles(es),
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              OutlinedButton.icon(
                onPressed: () => _confirmDelete(idx),
                icon: const Icon(Icons.delete_outline, size: 18),
                label: const Text('Delete'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Theme.of(context).colorScheme.error,
                  visualDensity: VisualDensity.compact,
                ),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                onPressed: isSaving ? null : () => _saveEntry(idx),
                icon: isSaving
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.save, size: 18),
                label: Text(isSaving ? 'Saving…' : 'Save'),
                style: FilledButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEditTags(int idx, _CardEditState es) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Tags', style: theme.textTheme.labelSmall),
        const SizedBox(height: 4),
        if (es.tags.isNotEmpty)
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: es.tags.asMap().entries.map((t) {
              return InputChip(
                label: Text(t.value,
                    style: const TextStyle(fontSize: 11)),
                onDeleted: () {
                  setState(() => es.tags.removeAt(t.key));
                },
                materialTapTargetSize:
                    MaterialTapTargetSize.shrinkWrap,
                visualDensity: VisualDensity.compact,
                deleteIcon: const Icon(Icons.close, size: 14),
              );
            }).toList(),
          ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: es.tagInputController,
                decoration: InputDecoration(
                  hintText: 'Add tag…',
                  isDense: true,
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8)),
                ),
                style: theme.textTheme.bodySmall,
                onSubmitted: (_) => _addTag(es),
              ),
            ),
            const SizedBox(width: 8),
            IconButton(
              onPressed: () => _addTag(es),
              icon: const Icon(Icons.add_circle_outline, size: 22),
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
          ],
        ),
      ],
    );
  }

  void _addTag(_CardEditState es) {
    final raw = es.tagInputController.text.trim().toLowerCase();
    if (raw.isEmpty) return;
    if (!es.tags.contains(raw)) {
      setState(() {
        es.tags.add(raw);
        es.tags.sort();
      });
    }
    es.tagInputController.clear();
  }

  int _computeDuration({
    required int startEpoch,
    int? endEpoch,
    required List<Map<String, dynamic>> pauses,
  }) {
    if (endEpoch == null) return 0;
    int totalPauseMs = 0;
    for (final p in pauses) {
      final start = p['pause_start'] as int?;
      final stop = p['pause_stop'] as int?;
      if (start != null && stop != null) {
        totalPauseMs += stop - start;
      }
    }
    final result = endEpoch - startEpoch - totalPauseMs;
    return result < 0 ? 0 : result;
  }

  Widget _buildEditEndTime(int idx, _CardEditState es) {
    final theme = Theme.of(context);
    final endDt = es.endEpoch != null
        ? DateTime.fromMillisecondsSinceEpoch(es.endEpoch!)
        : null;

    return InkWell(
      onTap: () => _pickEndDateTime(idx, es),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          border: Border.all(color: theme.colorScheme.outline),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            Icon(Icons.schedule,
                size: 18,
                color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: 8),
            Text(
              endDt != null
                  ? 'End: ${FormatUtils.dateTime(endDt)}'
                  : 'End time (tap to set)',
              style: theme.textTheme.bodySmall?.copyWith(
                color: endDt != null
                    ? theme.colorScheme.onSurface
                    : theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const Spacer(),
            if (es.endEpoch != null)
              IconButton(
                onPressed: () => setState(() => es.endEpoch = null),
                icon: const Icon(Icons.close, size: 16),
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickEndDateTime(int idx, _CardEditState es) async {
    final now = DateTime.now();
    final initial = es.endEpoch != null
        ? DateTime.fromMillisecondsSinceEpoch(es.endEpoch!)
        : now;

    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: now.add(const Duration(days: 1)),
    );
    if (date == null || !mounted) return;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial),
    );
    if (time == null || !mounted) return;

    final combined = DateTime(
      date.year, date.month, date.day, time.hour, time.minute);
    setState(() => es.endEpoch = combined.millisecondsSinceEpoch);
  }

  Widget _buildEditPauses(int idx, _CardEditState es) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Pauses', style: theme.textTheme.labelSmall),
            const Spacer(),
            TextButton.icon(
              onPressed: () => _addPause(es),
              icon: const Icon(Icons.add, size: 16),
              label: const Text('Add', style: TextStyle(fontSize: 12)),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
            ),
          ],
        ),
        if (es.pauses.isNotEmpty) ...[
          const SizedBox(height: 4),
          ...es.pauses.asMap().entries.map((p) {
            final pStart = p.value['pause_start'] as int? ?? 0;
            final pEnd = p.value['pause_stop'] as int?;
            final pStartDt = DateTime.fromMillisecondsSinceEpoch(pStart);
            final pEndDt = pEnd != null
                ? DateTime.fromMillisecondsSinceEpoch(pEnd)
                : null;
            final pDuration = pEndDt != null
                ? pEndDt.difference(pStartDt)
                : DateTime.now().difference(pStartDt);
            return Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 4),
              child: Row(
                children: [
                  Expanded(
                    child: InkWell(
                      onTap: () => _pickPauseTime(es, p.key, isStart: true),
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          border: Border.all(
                              color: theme.colorScheme.outline
                                  .withValues(alpha: 0.4)),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          FormatUtils.time(pStartDt),
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: Text('\u2013', style: theme.textTheme.bodySmall),
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: () =>
                          _pickPauseTime(es, p.key, isStart: false),
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          border: Border.all(
                              color: theme.colorScheme.outline
                                  .withValues(alpha: 0.4)),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          pEndDt != null
                              ? FormatUtils.time(pEndDt)
                              : 'ongoing',
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    ),
                  ),
                  Text(
                    ' (${FormatUtils.duration(pDuration)})',
                    style: theme.textTheme.bodySmall,
                  ),
                  IconButton(
                    onPressed: () =>
                        setState(() => es.pauses.removeAt(p.key)),
                    icon: const Icon(Icons.close, size: 16),
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(),
                  ),
                ],
              ),
            );
          }),
        ],
      ],
    );
  }

  void _addPause(_CardEditState es) {
    final now = DateTime.now().millisecondsSinceEpoch;
    setState(() {
      es.pauses.add({
        'pause_start': now,
        'pause_stop': now + 600000,
      });
    });
  }

  Future<void> _pickPauseTime(
      _CardEditState es, int pauseIdx, {required bool isStart}) async {
    final pause = es.pauses[pauseIdx];
    final epoch = (isStart
            ? pause['pause_start']
            : pause['pause_stop']) as int? ??
        DateTime.now().millisecondsSinceEpoch;
    final initial = DateTime.fromMillisecondsSinceEpoch(epoch);

    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (date == null || !mounted) return;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial),
    );
    if (time == null || !mounted) return;

    final combined = DateTime(
        date.year, date.month, date.day, time.hour, time.minute);
    setState(() {
      es.pauses[pauseIdx][isStart ? 'pause_start' : 'pause_stop'] =
          combined.millisecondsSinceEpoch;
    });
  }

  Widget _buildEncryptionToggles(_CardEditState es) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        border: Border.all(
            color: theme.colorScheme.outline.withValues(alpha: 0.3)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Encrypt Fields',
              style: theme.textTheme.labelSmall?.copyWith(
                  fontWeight: FontWeight.bold)),
          const SizedBox(height: 2),
          _encryptSwitch(
            'Title', es.encryptTitle,
            (v) => setState(() => es.encryptTitle = v),
          ),
          _encryptSwitch(
            'Tags', es.encryptTags,
            (v) => setState(() => es.encryptTags = v),
          ),
          _encryptSwitch(
            'Comment', es.encryptComment,
            (v) => setState(() => es.encryptComment = v),
          ),
        ],
      ),
    );
  }

  Widget _encryptSwitch(
      String label, bool value, ValueChanged<bool> onChanged) {
    return Row(
      children: [
        Icon(
          value ? Icons.lock : Icons.lock_open,
          size: 14,
          color: value
              ? Theme.of(context).colorScheme.primary
              : Theme.of(context).colorScheme.onSurfaceVariant,
        ),
        const SizedBox(width: 6),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        const Spacer(),
        Switch(
          value: value,
          onChanged: onChanged,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ],
    );
  }

  Widget _buildStatusBar() {
    final (label, icon, color) = _statusInfo();

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        border: Border(
          top: BorderSide(
            color: Theme.of(context).colorScheme.outlineVariant,
            width: 0.5,
          ),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 14, color: color),
            const SizedBox(width: 6),
            Text(
              label,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: color,
                    fontWeight: FontWeight.w600,
                  ),
            ),
          ],
        ),
      ),
    );
  }

  (String, IconData, Color) _statusInfo() {
    if (_isSyncing) {
      return ('Syncing…', Icons.sync, Theme.of(context).colorScheme.primary);
    }
    return switch (_status) {
      SyncCheckResult.ready => ('Ready', Icons.check_circle, Colors.green),
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

  Widget _buildErrorRow() {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline,
              size: 18, color: Theme.of(context).colorScheme.error),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _errorMessage!,
              style: TextStyle(
                color: Theme.of(context).colorScheme.error,
                fontSize: 13,
              ),
            ),
          ),
          TextButton(
            onPressed: _syncNow,
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            child: const Text('Retry', style: TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }
}

// ── Per-card editing state ──────────────────────────────────

class _CardEditState {
  final TextEditingController titleController;
  final TextEditingController commentController;
  final TextEditingController tagInputController;
  List<String> tags;
  bool encryptTitle;
  bool encryptTags;
  bool encryptComment;
  int? endEpoch;
  List<Map<String, dynamic>> pauses;

  _CardEditState({
    required String title,
    String? comment,
    required List<String> tags,
    required this.encryptTitle,
    required this.encryptTags,
    required this.encryptComment,
    this.endEpoch,
    required List<Map<String, dynamic>> pauses,
  })  : titleController = TextEditingController(text: title),
        commentController = TextEditingController(text: comment ?? ''),
        tagInputController = TextEditingController(),
        tags = List<String>.from(tags),
        pauses = List<Map<String, dynamic>>.from(pauses);

  void dispose() {
    titleController.dispose();
    commentController.dispose();
    tagInputController.dispose();
  }
}
