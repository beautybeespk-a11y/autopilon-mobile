import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/signup_screen.dart';
import '../../features/auth/presentation/forgot_password_screen.dart';
import '../../features/shell/presentation/app_shell.dart';
import '../../features/dashboard/presentation/dashboard_screen.dart';
import '../../features/chat/presentation/chat_screen.dart';
import '../../features/agents/presentation/agents_screen.dart';
import '../../features/tasks/presentation/tasks_screen.dart';
import '../../features/more/presentation/more_screen.dart';
import '../../features/automations/presentation/automations_screen.dart';
import '../../features/integrations/presentation/integrations_screen.dart';
import '../../features/settings/presentation/settings_screen.dart';
import '../../features/marketplace/presentation/marketplace_screen.dart';
import '../../features/marketplace/presentation/marketplace_asset_detail_screen.dart';
import '../../features/marketplace/presentation/marketplace_installs_screen.dart';
import '../../features/billing/presentation/billing_screen.dart';

/// A Listenable that pings go_router's `refreshListenable` whenever auth
/// status changes, so login/logout immediately re-evaluates `redirect`
/// below without needing a manual navigation call from every screen.
class AuthListenable extends ChangeNotifier {
  AuthListenable(this._ref) {
    _ref.listen(authControllerProvider, (_, __) => notifyListeners());
  }
  final Ref _ref;
}

final routerProvider = Provider<GoRouter>((ref) {
  final authListenable = AuthListenable(ref);

  return GoRouter(
    initialLocation: '/',
    refreshListenable: authListenable,
    redirect: (context, state) {
      final authState = ref.read(authControllerProvider);
      final loggingIn = ['/login', '/signup', '/forgot-password'].contains(state.matchedLocation);

      if (authState.status == AuthStatus.unknown) return null; // still restoring session — don't redirect yet
      if (authState.status == AuthStatus.unauthenticated && !loggingIn) return '/login';
      if (authState.status == AuthStatus.authenticated && loggingIn) return '/';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/signup', builder: (context, state) => const SignupScreen()),
      GoRoute(path: '/forgot-password', builder: (context, state) => const ForgotPasswordScreen()),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/', builder: (context, state) => const DashboardScreen()),
          GoRoute(path: '/chat', builder: (context, state) => const ChatScreen()),
          GoRoute(path: '/agents', builder: (context, state) => const AgentsScreen()),
          GoRoute(path: '/tasks', builder: (context, state) => const TasksScreen()),
          GoRoute(
            path: '/more',
            builder: (context, state) => const MoreScreen(),
            routes: [
              GoRoute(path: 'automations', builder: (context, state) => const AutomationsScreen()),
              GoRoute(path: 'integrations', builder: (context, state) => const IntegrationsScreen()),
              GoRoute(path: 'settings', builder: (context, state) => const SettingsScreen()),
              GoRoute(
                path: 'marketplace',
                builder: (context, state) => const MarketplaceScreen(),
                routes: [
                  // 'installs' must be declared before ':id' so it's matched
                  // as the literal segment, not swallowed as an asset id.
                  GoRoute(path: 'installs', builder: (context, state) => const MarketplaceInstallsScreen()),
                  GoRoute(
                    path: ':id',
                    builder: (context, state) => MarketplaceAssetDetailScreen(assetId: state.pathParameters['id']!),
                  ),
                ],
              ),
              GoRoute(path: 'billing', builder: (context, state) => const BillingScreen()),
            ],
          ),
        ],
      ),
    ],
  );
});
