import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Shared bottom-navigation scaffold for the main app shell.
///
/// Shown after auth (AppPhase.ready). Contains a BottomNavigationBar
/// with Dashboard, History, Sync, and Settings tabs.
class AppScaffold extends StatelessWidget {
  final Widget child;
  const AppScaffold({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: child,
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


