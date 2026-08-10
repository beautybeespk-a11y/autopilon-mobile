import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../organizations/presentation/organization_switcher_sheet.dart';
import '../../organizations/providers/organization_provider.dart';
import '../../auth/providers/auth_provider.dart';
import '../../notifications/presentation/notification_bell.dart';

/// The persistent frame for the authenticated part of the app — top bar
/// (app name + org switcher + notifications + logout) and a bottom nav
/// across Home/Chat/Agents/Tasks/More.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.child});
  final Widget child;

  static const _tabs = ['/', '/chat', '/agents', '/tasks', '/more'];

  int _indexForLocation(String location) {
    final i = _tabs.indexWhere((t) => location == t || (t != '/' && location.startsWith(t)));
    return i == -1 ? 0 : i;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final orgState = ref.watch(organizationControllerProvider);
    final activeOrgName = orgState.activeOrgId == null
        ? 'Personal'
        : orgState.organizations.where((o) => o.id == orgState.activeOrgId).map((o) => o.name).firstOrNull ?? '...';

    final location = GoRouterState.of(context).matchedLocation;
    final currentIndex = _indexForLocation(location);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Autopilon'),
        actions: [
          TextButton.icon(
            onPressed: () => showOrganizationSwitcher(context),
            icon: const Icon(Icons.swap_horiz, size: 18),
            label: Text(activeOrgName, overflow: TextOverflow.ellipsis),
          ),
          const NotificationBellButton(),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Log out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: currentIndex,
        onDestinationSelected: (i) => context.go(_tabs[i]),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.smart_toy_outlined), selectedIcon: Icon(Icons.smart_toy), label: 'Agents'),
          NavigationDestination(icon: Icon(Icons.checklist_outlined), selectedIcon: Icon(Icons.checklist), label: 'Tasks'),
          NavigationDestination(icon: Icon(Icons.more_horiz_outlined), selectedIcon: Icon(Icons.more_horiz), label: 'More'),
        ],
      ),
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
