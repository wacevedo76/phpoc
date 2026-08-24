import 'package:flutter/material.dart';

/// Add-entry capture sheet for the Commonplace Book.
///
/// Collects title, passage (`entry`), tags, and an optional ad-hoc note, then
/// calls [onSubmit]. The submit path **always adds a new committed entry**
/// (add-not-in-place, D5) — there is no edit affordance here. [onSubmit]
/// returns true on success (the sheet closes) and false on failure (stays open).
class AddEntryBottomSheet extends StatefulWidget {
  /// Invoked with the captured fields. Return true to close, false to keep open.
  final Future<bool> Function({
    required String title,
    required String entry,
    required List<String> tags,
    Map<String, dynamic>? adHoc,
  }) onSubmit;

  const AddEntryBottomSheet({super.key, required this.onSubmit});

  @override
  State<AddEntryBottomSheet> createState() => _AddEntryBottomSheetState();
}

class _AddEntryBottomSheetState extends State<AddEntryBottomSheet> {
  final _formKey = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _entry = TextEditingController();
  final _tags = TextEditingController();
  final _adHoc = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose();
    _entry.dispose();
    _tags.dispose();
    _adHoc.dispose();
    super.dispose();
  }

  List<String> _splitTags() => _tags.text
      .split(',')
      .map((t) => t.trim())
      .where((t) => t.isNotEmpty)
      .toList();

  Future<void> _save() async {
    if (_saving) return;
    if (!_formKey.currentState!.validate()) return;

    setState(() => _saving = true);
    final ok = await widget.onSubmit(
      title: _title.text.trim(),
      entry: _entry.text,
      tags: _splitTags(),
      adHoc:
          _adHoc.text.trim().isEmpty ? null : {'note': _adHoc.text.trim()},
    );
    if (!mounted) return;
    if (ok) Navigator.of(context).pop();
    setState(() => _saving = false);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Add a Commonplace entry',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _title,
              decoration: const InputDecoration(
                labelText: 'Title',
                hintText: 'Entry title',
              ),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Please enter a title' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _entry,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Passage',
                hintText: 'The passage to keep',
              ),
              validator: (v) => (v == null || v.trim().isEmpty)
                  ? 'The passage cannot be empty'
                  : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _tags,
              decoration: const InputDecoration(
                labelText: 'Tags',
                hintText: 'Comma-separated tags',
              ),
            ),
            const SizedBox(height: 8),
            TextFormField(
              controller: _adHoc,
              decoration: const InputDecoration(
                labelText: 'Ad-hoc note (optional)',
                hintText: 'Extra metadata',
              ),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed:
                      _saving ? null : () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Save'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
