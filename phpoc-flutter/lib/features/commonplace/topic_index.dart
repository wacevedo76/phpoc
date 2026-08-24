import 'package:flutter/material.dart';

/// Tag/topic index for the Commonplace Book.
///
/// Renders a horizontal row of topic chips built from a decrypt-and-scan
/// frequency index ([CommonplaceService.buildTagIndex]) — one chip per distinct
/// tag with its entry count, plus an "untagged" chip for entries with no tags.
/// Tapping a chip selects/deselects a filter; the parent screen filters the
/// entry list to the selected topic.
class TopicIndex extends StatelessWidget {
  /// Frequency map `tag → entryCount` (may include an 'untagged' key).
  final Map<String, int> tagIndex;

  /// The currently selected tag (or null for no filter).
  final String? selectedTag;

  /// Called when a chip is tapped; pass the tag name or null to clear.
  final ValueChanged<String?> onSelect;

  const TopicIndex({
    super.key,
    required this.tagIndex,
    required this.selectedTag,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final tags = tagIndex.keys.toList()..sort();
    if (tags.isEmpty) return const SizedBox.shrink();

    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        children: [
          for (final tag in tags)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: FilterChip(
                label: Text(tag),
                selected: selectedTag == tag,
                onSelected: (_) => onSelect(selectedTag == tag ? null : tag),
                selectedColor: scheme.primaryContainer,
                labelStyle: TextStyle(
                  color: selectedTag == tag
                      ? scheme.onPrimaryContainer
                      : scheme.onSurface,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
