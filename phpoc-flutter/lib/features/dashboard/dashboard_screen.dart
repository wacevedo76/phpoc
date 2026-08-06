import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show onboardingServiceProvider, syncServiceProvider;

/// Dashboard — active task card, uncommitted entries, collapsible new task.
///
/// Shows only running activities and completed-but-uncommitted entries.
/// A collapsed "New Task" bar sits at the bottom; tap to expand with
/// title, tags, comment, and an encrypt-fields toggle.
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  // ── Task capture form ──────────────────────────────────────

  final _titleController = TextEditingController();
  final _tagsController = TextEditingController();
  final _commentController = TextEditingController();
  bool _encryptTitle = false;
  bool _encryptTags = false;
  bool _encryptComment = false;
  bool _isOneOff = false;
  bool _isCapturing = false;
  bool _formExpanded = false;
  String? _errorMessage;

  // ── Active card state ─────────────────────────────────────

  final Set<String> _expandedActiveIds = {};

  // ── Data state ─────────────────────────────────────────────

  List<Map<String, dynamic>> _activeTasks = [];
  List<Map<String, dynamic>> _uncommittedEntries = [];
  bool _isLoading = true;
  bool _repairRun = false;
  Timer? _minuteTimer;

  @override
  void initState() {
    super.initState();
    _loadData();
    _startMinuteTimer();
  }

  void _startMinuteTimer() {
    _minuteTimer?.cancel();
    // Align to the next minute boundary so the display updates cleanly
    final now = DateTime.now();
    final secondsUntilNextMinute = 60 - now.second;
    _minuteTimer = Timer(Duration(seconds: secondsUntilNextMinute), () {
      if (mounted) setState(() {});
      // Switch to periodic 60s after first aligned tick
      _minuteTimer = Timer.periodic(const Duration(minutes: 1), (_) {
        if (mounted) setState(() {});
      });
    });
  }

  @override
  void dispose() {
    _minuteTimer?.cancel();
    _titleController.dispose();
    _tagsController.dispose();
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    final sync = ref.read(syncServiceProvider);

    // One-time repair: seed staging from ledger blocks for ledgers
    // imported before the staging-seeding fix was deployed.
    if (!_repairRun) {
      _repairRun = true;
      try {
        final onboarding = ref.read(onboardingServiceProvider);
        final seeded = await onboarding.repairMissingStagingEntries();
        if (seeded > 0) {
          debugPrint('[Dashboard] Repair seeded ~$seeded entries');
        }
      } catch (_) {
        // Best-effort — loading continues regardless of repair outcome.
      }
    }

    final activeList = await sync.getActive();
    final entries = await sync.getEntries();
    if (mounted) {
      setState(() {
        _activeTasks = activeList;
        _uncommittedEntries = entries
            .where((e) => e['is_active'] != true && e['committed'] != true)
            .toList();
        _isLoading = false;
      });
    }
  }

  // ── Capture ────────────────────────────────────────────────

  List<String> _parseTags() {
    final raw = _tagsController.text.trim();
    if (raw.isEmpty) return [];
    return raw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .where((t) => t.isNotEmpty)
        .toSet()
        .toList();
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

      final encrypted = <String>{};
      if (_encryptTitle) encrypted.add('title');
      if (_encryptTags) encrypted.add('tags');
      if (_encryptComment) encrypted.add('comment');

      await sync.capture(
        title: title,
        tags: _parseTags(),
        comment: _commentController.text.trim().isEmpty
            ? null
            : _commentController.text.trim(),
        encryptFields: encrypted,
        isOneOff: _isOneOff,
      );
      _titleController.clear();
      _tagsController.clear();
      _commentController.clear();
      setState(() {
        _formExpanded = false;
        _isOneOff = false;
      });
      await _loadData();
      if (mounted) setState(() => _isCapturing = false);
    } catch (e) {
      if (mounted) {
        setState(() {
          _isCapturing = false;
          _errorMessage = 'Failed to start task: $e';
        });
      }
    }
  }

  // ── Task actions ───────────────────────────────────────────

  Future<void> _endTask(String entryId) async {
    try {
      final sync = ref.read(syncServiceProvider);
      await sync.endByEntryId(entryId, DateTime.now().millisecondsSinceEpoch);
      await _loadData();
    } catch (e) {
      debugPrint('Dashboard: _endTask failed for $entryId: $e');
    }
  }

  Future<void> _togglePause(String entryId, bool isPaused) async {
    try {
      final sync = ref.read(syncServiceProvider);
      final now = DateTime.now().millisecondsSinceEpoch;
      if (isPaused) {
        await sync.unpauseByEntryId(entryId, now);
      } else {
        await sync.pauseByEntryId(entryId, now);
      }
      await _loadData();
    } catch (e) {
      debugPrint('Dashboard: _togglePause failed for $entryId: $e');
    }
  }

  // ── Build ──────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PH Ledger')),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _loadData,
              child: _buildContent(),
            ),
      bottomSheet: _buildNewTaskPanel(),
    );
  }

  Widget _buildContent() {
    final hasActive = _activeTasks.isNotEmpty;
    final hasUncommitted = _uncommittedEntries.isNotEmpty;

    if (!hasActive && !hasUncommitted) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [_buildEmptyState()],
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 80),
      children: [
        // Running activities
        if (hasActive) ...[
          _buildSectionHeader('Running', Icons.play_circle_outline),
          ..._activeTasks.map((task) => _buildActiveTaskCard(task)),
        ],
        // Uncommitted completed entries
        if (hasUncommitted) ...[
          if (hasActive) const SizedBox(height: 16),
          _buildSectionHeader('Pending Commit', Icons.cloud_upload_outlined),
          const SizedBox(height: 8),
          ..._uncommittedEntries.map(_buildUncommittedCard),
        ],
      ],
    );
  }

  // ── Empty state ────────────────────────────────────────────

  Widget _buildEmptyState() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Center(
        child: Column(
          children: [
            Icon(
              Icons.inbox_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 12),
            Text(
              'No activities yet',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 4),
            Text(
              'Tap "+ New Task" below to start tracking',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  // ── Section header ─────────────────────────────────────────

  Widget _buildSectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
        const SizedBox(width: 8),
        Text(
          title,
          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                color: Theme.of(context).colorScheme.primary,
                fontWeight: FontWeight.bold,
              ),
        ),
      ],
    );
  }

  // ── Active task card (collapsible, icon-only buttons) ──────

  Widget _buildActiveTaskCard(Map<String, dynamic> task) {
    final entryId = task['entry_id'] as String? ?? '';
    final title = task['title'] as String? ?? 'Untitled';
    final startEpoch = task['start_epoch'] as int? ?? 0;
    final isPaused = task['is_paused'] == true;
    final tags = (task['tags'] as List?)?.cast<String>() ?? [];
    final comment = task['comment'] as String?;
    final elapsed = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(startEpoch),
    );
    final cardExpanded = _expandedActiveIds.contains(entryId);

    return Card(
      color: Theme.of(context).colorScheme.primaryContainer,
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── Header (tappable to expand/collapse) ────────────
          InkWell(
            onTap: () {
              setState(() {
                if (cardExpanded) {
                  _expandedActiveIds.remove(entryId);
                } else {
                  _expandedActiveIds.add(entryId);
                }
              });
            },
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Row(
                children: [
                  Icon(Icons.play_circle_fill,
                      color: Theme.of(context).colorScheme.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      title,
                      style:
                          Theme.of(context).textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                    ),
                  ),
                  if (isPaused)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: const Icon(Icons.pause_circle_filled,
                          size: 18, color: Colors.amber),
                    ),
                  Icon(
                    cardExpanded
                        ? Icons.expand_less
                        : Icons.expand_more,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          _buildActiveCardActions(entryId, isPaused, elapsed),
          // ── Expanded body ────────────────────────────────────
          AnimatedCrossFade(
            firstChild: const SizedBox.shrink(),
            secondChild: _buildExpandedBody(tags, comment, startEpoch),
            crossFadeState: cardExpanded
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 200),
          ),
        ],
      ),
    );
  }

  Widget _buildExpandedBody(
    List<String> tags,
    String? comment,
    int startEpoch,
  ) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (tags.isNotEmpty) ...[
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: tags
                  .map((t) => Chip(
                        label:
                            Text(t, style: const TextStyle(fontSize: 12)),
                        materialTapTargetSize:
                            MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                      ))
                  .toList(),
            ),
            const SizedBox(height: 8),
          ],
          if (comment != null && comment.isNotEmpty) ...[
            Text(
              comment,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontStyle: FontStyle.italic,
                  ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 8),
          ],
          Text(
            'Started: ${FormatUtils.dateTime(DateTime.fromMillisecondsSinceEpoch(startEpoch))}',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: const Color(0xFFFF00FF),
            ),
          ),
        ],
      ),
    );
  }

  /// Pause/Resume and End action buttons for an active task card.
  Widget _buildActiveCardActions(
    String entryId,
    bool isPaused,
    Duration elapsed,
  ) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 12, 8),
      child: Row(
        children: [
          Text(
            'Elapsed: ${FormatUtils.duration(elapsed)}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const Spacer(),
          // Pause / Resume — filled yellow, black icon
          SizedBox(
            width: 32,
            height: 28,
            child: FilledButton(
              onPressed: () => _togglePause(entryId, isPaused),
              style: FilledButton.styleFrom(
                padding: EdgeInsets.zero,
                backgroundColor: Colors.amber,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6)),
              ),
              child: Icon(
                isPaused ? Icons.play_arrow : Icons.pause,
                size: 16,
                color: Colors.black,
              ),
            ),
          ),
          const SizedBox(width: 6),
          // End — red fill, white icon
          SizedBox(
            width: 32,
            height: 28,
            child: FilledButton(
              onPressed: () => _endTask(entryId),
              style: FilledButton.styleFrom(
                padding: EdgeInsets.zero,
                backgroundColor: Theme.of(context).colorScheme.error,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6)),
              ),
              child: const Icon(Icons.stop, size: 16),
            ),
          ),
        ],
      ),
    );
  }

  // ── Uncommitted entry card (collapsible, orange border) ───
  //
  // Keys are list indices (uncommitted entries may not have stable
  // entry IDs, so we use index-based tracking for expand/collapse state).

  final Set<int> _expandedUncommitted = {};

  Widget _buildUncommittedCard(Map<String, dynamic> entry) {
    final entryIdx = _uncommittedEntries.indexOf(entry);
    final isExpanded = _expandedUncommitted.contains(entryIdx);

    final title = entry['title'] as String? ?? 'Untitled';
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final duration = entry['duration'] as int? ?? 0;
    final tags = (entry['tags'] as List?)?.cast<String>() ?? [];
    final comment = entry['comment'] as String?;
    final pauses = (entry['pauses'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Colors.orange, width: 2),
      ),
      child: InkWell(
        onTap: () {
          setState(() {
            if (isExpanded) {
              _expandedUncommitted.remove(entryIdx);
            } else {
              _expandedUncommitted.add(entryIdx);
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
                  Icon(Icons.check_circle_outline,
                      size: 18,
                      color: Theme.of(context).colorScheme.onSurfaceVariant),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(title,
                        style: Theme.of(context).textTheme.bodyLarge),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    FormatUtils.duration(Duration(milliseconds: duration)),
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
                FormatUtils.dateTime(startDt),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: const Color(0xFFFF00FF),
                ),
              ),
              AnimatedCrossFade(
                firstChild: const SizedBox.shrink(),
                secondChild: _buildUncommittedDetail(tags, comment, pauses),
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

  Widget _buildUncommittedDetail(
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
              spacing: 6,
              runSpacing: 4,
              children: tags
                  .map((t) => Chip(
                        label:
                            Text(t, style: const TextStyle(fontSize: 11)),
                        materialTapTargetSize:
                            MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                      ))
                  .toList(),
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
              final pStart = p['pause_start'] as int? ?? 0;
              final pEnd = p['pause_stop'] as int?;
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

  // ═════════════════════════════════════════════════════════════
  // Bottom "New Task" panel
  // ═════════════════════════════════════════════════════════════

  Widget _buildNewTaskPanel() {
    return AnimatedCrossFade(
      firstChild: _buildCollapsedBar(),
      secondChild: _buildExpandedForm(),
      crossFadeState: _formExpanded
          ? CrossFadeState.showSecond
          : CrossFadeState.showFirst,
      duration: const Duration(milliseconds: 250),
    );
  }

  /// Collapsed: a tappable bar showing "+ New Task".
  Widget _buildCollapsedBar() {
    return InkWell(
      onTap: () => setState(() => _formExpanded = true),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
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
              Icon(Icons.add_circle_outline,
                  size: 20, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 8),
              Text(
                'New Task',
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                    ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Expanded: title + encrypt ☑, tags + encrypt ☑, comment + encrypt ☑,
  /// "Encrypt all fields" toggle, Cancel, Start.
  Widget _buildExpandedForm() {
    final allOn = _encryptTitle && _encryptTags && _encryptComment;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
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
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildFieldRow(
              controller: _titleController,
              hintText: 'What are you working on?',
              encryptValue: _encryptTitle,
              onEncryptChanged: (v) => setState(() => _encryptTitle = v),
              autofocus: true,
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: 8),
            _buildFieldRow(
              controller: _tagsController,
              hintText: 'Tags (comma-separated)',
              prefixIcon: const Icon(Icons.label_outline, size: 20),
              encryptValue: _encryptTags,
              onEncryptChanged: (v) => setState(() => _encryptTags = v),
            ),
            const SizedBox(height: 8),
            _buildFieldRow(
              controller: _commentController,
              hintText: 'Comment (optional)',
              prefixIcon: const Icon(Icons.notes, size: 20),
              encryptValue: _encryptComment,
              onEncryptChanged: (v) => setState(() => _encryptComment = v),
              maxLines: 2,
              textCapitalization: TextCapitalization.sentences,
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
            const SizedBox(height: 8),
            const SizedBox(height: 8),
            Row(
              children: [
                Checkbox(
                  value: _isOneOff,
                  onChanged: (v) => setState(() => _isOneOff = v ?? false),
                  visualDensity: VisualDensity.compact,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                GestureDetector(
                  onTap: () =>
                      setState(() => _isOneOff = !_isOneOff),
                  child: const Text('One-off'),
                ),
                const SizedBox(width: 16),
              ],
            ),
            Row(
              children: [
                Expanded(
                  child: FilterChip(
                    selected: allOn,
                    onSelected: (v) {
                      setState(() {
                        _encryptTitle = v;
                        _encryptTags = v;
                        _encryptComment = v;
                      });
                    },
                    avatar: Icon(
                      allOn ? Icons.lock : Icons.lock_open,
                      size: 16,
                    ),
                    label: const Text('Encrypt all fields'),
                    visualDensity: VisualDensity.compact,
                  ),
                ),
                const SizedBox(width: 8),
                SmallOutlinedButton(
                  onPressed: () {
                    setState(() {
                      _formExpanded = false;
                      _errorMessage = null;
                    });
                  },
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: _isCapturing ? null : _capture,
                  icon: _isCapturing
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.play_arrow, size: 18),
                  label: const Text('Start'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// A text field with an encryption ☑ checkbox on the right.
  Widget _buildFieldRow({
    required TextEditingController controller,
    required String hintText,
    Widget? prefixIcon,
    required bool encryptValue,
    required ValueChanged<bool> onEncryptChanged,
    bool autofocus = false,
    int? maxLines,
    TextCapitalization textCapitalization = TextCapitalization.none,
  }) {
    return Row(
      crossAxisAlignment: maxLines != null && maxLines > 1
          ? CrossAxisAlignment.start
          : CrossAxisAlignment.center,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            autofocus: autofocus,
            textCapitalization: textCapitalization,
            maxLines: maxLines ?? 1,
            decoration: InputDecoration(
              hintText: hintText,
              prefixIcon: prefixIcon,
              border: const OutlineInputBorder(),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              isDense: true,
            ),
          ),
        ),
        const SizedBox(width: 4),
        Tooltip(
          message:
              encryptValue ? 'Field is encrypted' : 'Field is stored plain',
          child: InkWell(
            onTap: () => onEncryptChanged(!encryptValue),
            borderRadius: BorderRadius.circular(4),
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Icon(
                encryptValue ? Icons.lock : Icons.lock_open,
                size: 18,
                color: encryptValue
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Thin outlined button matching the visual density of the form row.
class SmallOutlinedButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final Widget child;
  const SmallOutlinedButton({super.key, this.onPressed, required this.child});

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      child: child,
    );
  }
}
