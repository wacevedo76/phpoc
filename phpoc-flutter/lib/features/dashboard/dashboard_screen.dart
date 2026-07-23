import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show syncServiceProvider;
import 'package:phpoc_flutter/data/sync/sync_service.dart';

/// Dashboard — active task card, quick capture, recent entries.
///
/// The primary user-facing screen after unlock. Shows live active task
/// with duration timer, a "Start New Task" form, and recent entries.
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  final _titleController = TextEditingController();
  String? _errorMessage;
  bool _isCapturing = false;

  Map<String, dynamic>? _activeTask;
  List<Map<String, dynamic>> _recentEntries = [];
  bool _isLoading = true;

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    final sync = ref.read(syncServiceProvider);
    final active = await sync.getActive();
    final entries = await sync.getEntries();
    if (mounted) {
      setState(() {
        _activeTask = active;
        _recentEntries = entries.where((e) => e['is_active'] != true).toList();
        _isLoading = false;
      });
    }
  }

  Future<void> _capture() async {
    final title = _titleController.text.trim();
    if (title.isEmpty) {
      setState(() => _errorMessage = 'Please enter a task title');
      return;
    }

    setState(() {
      _isCapturing = true;
      _errorMessage = null;
    });

    try {
      final sync = ref.read(syncServiceProvider);
      await sync.capture(title: title);
      _titleController.clear();
      await _loadData();
      if (mounted) {
        setState(() => _isCapturing = false);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isCapturing = false;
          _errorMessage = 'Failed to start task: $e';
        });
      }
    }
  }

  Future<void> _endTask(String title) async {
    try {
      final sync = ref.read(syncServiceProvider);
      await sync.end(title, DateTime.now().millisecondsSinceEpoch);
      await _loadData();
    } catch (_) {}
  }

  Future<void> _togglePause(String title, bool isPaused) async {
    try {
      final sync = ref.read(syncServiceProvider);
      final now = DateTime.now().millisecondsSinceEpoch;
      if (isPaused) {
        await sync.unpause(title, now);
      } else {
        await sync.pause(title, now);
      }
      await _loadData();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PH Ledger')),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _loadData,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Start New Task form
                  _buildCaptureForm(),
                  const SizedBox(height: 16),
                  // Active task card
                  if (_activeTask != null) ...[
                    _buildActiveTaskCard(),
                    const SizedBox(height: 16),
                  ],
                  // Recent entries
                  _buildRecentEntries(),
                ],
              ),
            ),
    );
  }

  Widget _buildCaptureForm() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'New Task',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _titleController,
                    decoration: InputDecoration(
                      hintText: 'What are you working on?',
                      errorText: _errorMessage,
                      border: const OutlineInputBorder(),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: _isCapturing ? null : _capture,
                  icon: _isCapturing
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.play_arrow),
                  label: const Text('Start'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildActiveTaskCard() {
    final task = _activeTask!;
    final title = task['title'] as String? ?? 'Untitled';
    final startEpoch = task['start_epoch'] as int? ?? 0;
    final isPaused = task['is_paused'] == true;
    final elapsed = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(startEpoch),
    );

    return Card(
      color: Theme.of(context).colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.play_circle_fill,
                    color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                ),
                if (isPaused)
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text('Paused', style: TextStyle(fontSize: 12)),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Started: ${FormatUtils.dateTime(DateTime.fromMillisecondsSinceEpoch(startEpoch))}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            Text(
              'Elapsed: ${FormatUtils.duration(elapsed)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                // Pause / Resume
                OutlinedButton.icon(
                  onPressed: () => _togglePause(title, isPaused),
                  icon: Icon(isPaused ? Icons.play_arrow : Icons.pause),
                  label: Text(isPaused ? 'Resume' : 'Pause'),
                ),
                const SizedBox(width: 8),
                // End
                FilledButton.icon(
                  onPressed: () => _endTask(title),
                  icon: const Icon(Icons.stop),
                  label: const Text('End'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.error,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRecentEntries() {
    final recent = _recentEntries.take(10).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Recent Tasks',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        if (recent.isEmpty && _activeTask == null)
          _buildEmptyState()
        else if (recent.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Center(
              child: Text(
                'No completed tasks yet',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ),
          )
        else
          ...recent.map(_buildEntryCard),
      ],
    );
  }

  Widget _buildEmptyState() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32),
      child: Center(
        child: Column(
          children: [
            Icon(
              Icons.inbox_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 8),
            Text(
              'No tasks yet',
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 4),
            Text(
              'Tap "Start New Task" to begin tracking your time',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEntryCard(Map<String, dynamic> entry) {
    final title = entry['title'] as String? ?? 'Untitled';
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final duration = entry['duration'] as int? ?? 0;
    final endEpoch = entry['end_epoch'] as int?;
    final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: const Icon(Icons.check_circle_outline),
        title: Text(title),
        subtitle: Text(
          '${FormatUtils.date(startDt)} · ${FormatUtils.duration(Duration(milliseconds: duration))}',
        ),
        trailing:
            endEpoch != null ? const Icon(Icons.chevron_right) : null,
        onTap: () {
          // Navigate to history filtered by this date
        },
      ),
    );
  }


}
