import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/auth/biometric_gate.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';
import 'features/auth/providers/auth_provider.dart';
import 'features/settings/providers/settings_provider.dart';

class AutopilonApp extends ConsumerStatefulWidget {
  const AutopilonApp({super.key});

  @override
  ConsumerState<AutopilonApp> createState() => _AutopilonAppState();
}

class _AutopilonAppState extends ConsumerState<AutopilonApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Locks on the way OUT (.paused), not the way back in — see the long
    // comment on BiometricGateController for why .resumed would race with
    // a successful unlock() via the same dialog-closing lifecycle blip.
    // The controller itself no-ops unless biometric lock is enabled.
    if (state == AppLifecycleState.paused) {
      ref.read(biometricGateControllerProvider.notifier).onAppBackgrounded();
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);
    final authStatus = ref.watch(authControllerProvider).status;
    final themeMode = ref.watch(themeModeControllerProvider);
    final locked = ref.watch(biometricGateControllerProvider);

    return MaterialApp.router(
      title: 'Autopilon',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,
      routerConfig: router,
      builder: (context, child) {
        // While restoring a persisted session (checking the cookie jar
        // against GET /auth/me), show a splash instead of letting the
        // router briefly flash the login screen for someone who's actually
        // already signed in.
        if (authStatus == AuthStatus.unknown) {
          return const _SplashScreen();
        }
        if (authStatus == AuthStatus.authenticated && locked) {
          return const BiometricLockScreen();
        }
        return child ?? const SizedBox.shrink();
      },
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();
  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
