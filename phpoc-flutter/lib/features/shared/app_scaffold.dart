import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../data/storage/providers.dart' show appPreferencesProvider;
import '../commonplace/commonplace_screen.dart';
import '../commonplace/commonplace_settings_screen.dart';
import 'book_switcher.dart';

/// Shared bottom-navigation scaffold for the main app shell.
///
/// Shown after auth (AppPhase.ready). Renders a book-switcher bar
/// ([BookSwitcher]) above the page, then a BottomNavigationBar with
/// Dashboard, History, Sync, and Settings tabs.
class AppScaffold extends ConsumerWidget {
  final Widget child;
  const AppScaffold({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Reactively derive the active book from the persisted `book_mode`. Both
    // the BookSwitcher's `select()` (persists then notifies) and any direct
    // `setBookMode` update the same ValueNotifier, so the body swap reflects
    // the current book after the persisted value changes.
    final prefs = ref.watch(appPreferencesProvider);

    return ValueListenableBuilder<String?>(
      valueListenable: prefs.bookMode,
      builder: (context, key, _) {
        final book = Book.fromKey(key);
        // When the Commonplace Book is active, swap the routed page child for
        // the Commonplace dashboard surface. The bottom-nav tabs and
        // BookSwitcher bar stay mounted (shared shell); only the body content
        // is book-scoped.
        final Widget body;
        if (book == Book.commonplace) {
          // Only the `/settings` route redirects to the Commonplace settings
          // page; Dashboard/History/Sync keep the dashboard content-swap
          // (CPS-S5). For the Ledger book the routed child is preserved
          // (CPS-S1/S6).
          final isSettings =
              GoRouterState.of(context).matchedLocation == '/settings';
          body = isSettings
              ? const CommonplaceSettingsScreen()
              : const CommonplaceScreen();
        } else {
          body = child;
        }
        return _buildScaffold(context, body);
      },
    );
  }

  Widget _buildScaffold(BuildContext context, Widget body) {
    return Scaffold(
      body: Column(
        children: [
          const BookSwitcher(),
          // The BookSwitcher's SafeArea already accounts for the top status-bar
          // inset (MediaQuery.padding.top). If the page's own AppBar re-adds it,
          // the title text is pushed ~2/3 lower than its symmetric center.
          // Remove the top padding here so each page AppBar keeps the title
          // vertically centered (top gap == bottom gap).
          Expanded(
            child: MediaQuery(
              // The BookSwitcher's SafeArea already accounts for the top
              // status-bar inset (see above). We must ALSO remove the bottom
              // view inset here: the outer Scaffold already resizes its body
              // for the keyboard (resizeToAvoidBottomInset) and strips
              // viewInsets.bottom from that body, but this explicit MediaQuery
              // is built from the ROOT MediaQuery (which still carries the
              // full keyboard inset). Re-introducing it makes every nested
              // page Scaffold double-apply the keyboard inset, collapsing its
              // body and pushing bottom-anchored panels (e.g. the dashboard
              // "New Task" form) out of position when the keyboard opens.
              data: MediaQuery.of(context)
                  .removePadding(removeTop: true)
                  .removeViewInsets(removeBottom: true),
              child: body,
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex(context),
        onDestinationSelected: (index) => _onTabSelected(context, index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          NavigationDestination(
            icon: Icon(Icons.history_outlined),
            selectedIcon: Icon(Icons.history),
            label: 'History',
          ),
          NavigationDestination(
            icon: Icon(Icons.sync_outlined),
            selectedIcon: Icon(Icons.sync),
            label: 'Sync',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }

  int _selectedIndex(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    if (location == '/history') return 1;
    if (location == '/sync') return 2;
    if (location == '/settings') return 3;
    return 0; // dashboard — '/'
  }

  void _onTabSelected(BuildContext context, int index) {
    final routes = ['/', '/history', '/sync', '/settings'];
    if (index >= 0 && index < routes.length) {
      context.go(routes[index]);
    }
  }
}
