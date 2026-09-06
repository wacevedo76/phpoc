import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../data/storage/providers.dart' show appPreferencesProvider;
import '../commonplace/commonplace_screen.dart';
import '../commonplace/commonplace_settings_screen.dart';
import 'book_switcher.dart';

/// Shared navigation scaffold for the main app shell.
///
/// Shown after auth (AppPhase.ready). Renders a book-switcher bar
/// ([BookSwitcher]) above the page, then a taskbar with Dashboard, History,
/// Sync, and Settings tabs — a [NavigationBar] along the bottom in portrait,
/// or a [NavigationRail] along the left edge in landscape.
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
    final isLandscape =
        MediaQuery.orientationOf(context) == Orientation.landscape;
    final content = Column(
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
    );

    if (isLandscape) {
      // Landscape: move the taskbar to the left edge as a NavigationRail so
      // the reduced vertical space isn't consumed by a bottom bar. The rail is
      // wrapped in SafeArea to clear any status bar/notch on the left edge.
      return Scaffold(
        body: Row(
          children: [
            // Only clear the top status-bar inset here. The left display-cutout
            // is handled by NavigationRail's own internal SafeArea, and the
            // right side must NOT be padded — in landscape the system
            // navigation-bar inset (padding.right) lives on the right edge, far
            // from this left rail, so applying it here just leaves a wide empty
            // gutter between the rail and the content.
            SafeArea(left: false, right: false, child: _buildNavRail(context)),
            const VerticalDivider(thickness: 1, width: 1),
            Expanded(child: content),
          ],
        ),
      );
    }

    return Scaffold(
      body: content,
      bottomNavigationBar: _buildNavBar(context),
    );
  }

  NavigationBar _buildNavBar(BuildContext context) {
    return NavigationBar(
      selectedIndex: _selectedIndex(context),
      onDestinationSelected: (index) => _onTabSelected(context, index),
      destinations: [
        for (final tab in _tabs)
          NavigationDestination(
            icon: Icon(tab.icon),
            selectedIcon: Icon(tab.selectedIcon),
            label: tab.label,
          ),
      ],
    );
  }

  NavigationRail _buildNavRail(BuildContext context) {
    return NavigationRail(
      selectedIndex: _selectedIndex(context),
      onDestinationSelected: (index) => _onTabSelected(context, index),
      // Labels stay visible under the icons for clarity. They are NOT what
      // widened the landscape taskbar — on device the rail stays ~80px; the
      // extra right-side gutter came from the system navigation-bar inset,
      // now removed by the parent SafeArea (left/right disabled).
      labelType: NavigationRailLabelType.all,
      minWidth: 64,
      destinations: [
        for (final tab in _tabs)
          NavigationRailDestination(
            icon: Icon(tab.icon),
            selectedIcon: Icon(tab.selectedIcon),
            label: Text(tab.label),
          ),
      ],
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

/// The four main destinations shown by the shell taskbar (bottom bar in
/// portrait, left rail in landscape).
const _tabs = <_ShellTab>[
  _ShellTab(Icons.dashboard_outlined, Icons.dashboard, 'Dashboard'),
  _ShellTab(Icons.history_outlined, Icons.history, 'History'),
  _ShellTab(Icons.sync_outlined, Icons.sync, 'Sync'),
  _ShellTab(Icons.settings_outlined, Icons.settings, 'Settings'),
];

class _ShellTab {
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  const _ShellTab(this.icon, this.selectedIcon, this.label);
}
