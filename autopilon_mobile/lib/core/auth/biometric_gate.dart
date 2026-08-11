import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import '../storage/secure_storage.dart';

/// Whether this device even offers biometrics — Settings hides the toggle
/// entirely (rather than showing a switch that would just fail) when false.
final biometricSupportProvider = FutureProvider<bool>((ref) async {
  final auth = LocalAuthentication();
  try {
    return await auth.canCheckBiometrics && await auth.isDeviceSupported();
  } catch (_) {
    // local_auth throws on platforms/configs it isn't set up for — treat
    // that the same as "not supported" rather than crashing Settings.
    return false;
  }
});

/// The user's on/off preference (Settings > Security), persisted so it
/// survives app restarts. Kept separate from BiometricGateController's own
/// "is the app currently locked" state below — this is just the setting.
class BiometricLockEnabledController extends StateNotifier<bool> {
  BiometricLockEnabledController() : super(false) {
    _restore();
  }
  Future<void> _restore() async => state = await SecureStorage.getBiometricLockEnabled();

  Future<void> setEnabled(bool value) async {
    state = value;
    await SecureStorage.setBiometricLockEnabled(value);
  }
}

final biometricLockEnabledProvider =
    StateNotifierProvider<BiometricLockEnabledController, bool>((ref) => BiometricLockEnabledController());

/// Whether the lock screen should be showing right now. True on cold start
/// (once the persisted preference loads, if enabled) and set again every
/// time the app leaves the foreground — AutopilonApp's WidgetsBindingObserver
/// drives the latter by calling onAppBackgrounded().
///
/// Deliberately locks on the way OUT (AppLifecycleState.paused) rather than
/// the way back IN (.resumed): showing the OS fingerprint/face dialog from
/// unlock() below itself briefly pauses-then-resumes the Flutter app, so
/// locking on .resumed would immediately re-lock right after a *successful*
/// unlock — the same lifecycle blip closing the dialog looks identical to
/// the user actually leaving and coming back. Locking on .paused instead
/// means that blip just re-confirms the (already-true) locked state, and a
/// successful unlock() staying unlocked is never raced.
class BiometricGateController extends StateNotifier<bool> {
  BiometricGateController() : super(false) {
    _init();
  }
  final _auth = LocalAuthentication();
  bool _enabled = false;

  Future<void> _init() async {
    _enabled = await SecureStorage.getBiometricLockEnabled();
    if (_enabled) state = true;
  }

  /// Called from Settings when the toggle changes, so a background/resume
  /// within the same session immediately reflects the new preference
  /// without waiting for the next cold start.
  void setEnabled(bool value) => _enabled = value;

  void onAppBackgrounded() {
    if (_enabled) state = true;
  }

  Future<bool> unlock() async {
    try {
      final ok = await _auth.authenticate(
        localizedReason: 'Unlock Autopilon',
        options: const AuthenticationOptions(stickyAuth: true),
      );
      if (ok) state = false;
      return ok;
    } catch (_) {
      return false;
    }
  }
}

final biometricGateControllerProvider =
    StateNotifierProvider<BiometricGateController, bool>((ref) => BiometricGateController());

/// The actual lock screen shown in place of the app when locked.
class BiometricLockScreen extends ConsumerWidget {
  const BiometricLockScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.fingerprint, size: 64, color: Theme.of(context).colorScheme.primary),
              const SizedBox(height: 16),
              Text('Autopilon is locked', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              const Text('Unlock with your fingerprint or face to continue.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => ref.read(biometricGateControllerProvider.notifier).unlock(),
                icon: const Icon(Icons.lock_open),
                label: const Text('Unlock'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
