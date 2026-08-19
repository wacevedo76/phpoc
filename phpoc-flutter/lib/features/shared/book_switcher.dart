import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show appPreferencesProvider;

/// The two "books" a user can view within phpoc.
///
/// - [Book.ledger] — the main activity ledger (PH Ledger).
/// - [Book.commonplace] — the personal thematic library (Commonplace Book).
///
/// This slice introduces the identity + selection state only: the switcher
/// bar is rendered above each main page, but page content stays on the ledger
/// until the Commonplace screens are built (see BACKLOG "UI wiring" slice).
enum Book {
  ledger('ledger', 'PH Ledger'),
  commonplace('commonplace', 'PH Commonplace Book');

  /// Persisted string key (used by [AppPreferences.getBookMode]).
  final String key;

  /// Human-readable title shown in the switcher bar.
  final String label;

  const Book(this.key, this.label);

  /// Map a persisted key string back to a [Book]; defaults to [Book.ledger].
  static Book fromKey(String? key) {
    return Book.values.firstWhere(
      (b) => b.key == key,
      orElse: () => Book.ledger,
    );
  }
}

/// Riverpod notifier owning the active [Book].
///
/// Initializes from persisted `AppPreferences` (default [Book.ledger]) and
/// persists every selection so the choice survives an app restart.
class BookNotifier extends StateNotifier<Book> {
  final dynamic _prefs;
  BookNotifier(this._prefs) : super(Book.ledger) {
    _load();
  }

  Future<void> _load() async {
    final mode = await _prefs.getBookMode();
    if (!mounted) return;
    state = Book.fromKey(mode);
  }

  /// Switch the active book and persist the choice.
  Future<void> select(Book book) async {
    if (book == state) return;
    state = book;
    await _prefs.setBookMode(book.key);
  }
}

/// The active [Book]. Overritable in tests via `data_providers.appPreferencesProvider`.
final bookProvider =
    StateNotifierProvider<BookNotifier, Book>((ref) {
  return BookNotifier(ref.watch(appPreferencesProvider));
});

/// Persistent title bar showing the active book with a pull-down to switch.
///
/// Rendered once by the shell ([AppScaffold]) above each page's own AppBar so
/// it reads "PH Ledger" / "PH Commonplace Book" consistently across Dashboard,
/// History, Sync, and Settings. Choosing a different book updates [bookProvider]
/// (persisted); page content is not swapped until Commonplace screens exist.
class BookSwitcher extends ConsumerWidget {
  const BookSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final book = ref.watch(bookProvider);
    final scheme = Theme.of(context).colorScheme;

    return Material(
      color: scheme.primaryContainer,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: 44,
          child: PopupMenuButton<Book>(
            onSelected: (b) => ref.read(bookProvider.notifier).select(b),
            itemBuilder: (context) => [
              for (final b in Book.values)
                PopupMenuItem<Book>(
                  value: b,
                  child: Text(b.label),
                ),
            ],
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.menu_book_outlined, size: 18),
                const SizedBox(width: 6),
                Text(
                  book.label,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                    color: scheme.onPrimaryContainer,
                  ),
                ),
                Icon(Icons.arrow_drop_down,
                    size: 20, color: scheme.onPrimaryContainer),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
