import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/provider_status_model.dart';
import '../../../core/storage/secure_storage.dart';

/// Fetches GET /chat/provider-status once — same read-only info the web
/// Settings page shows ("AI provider configured and ready" / not configured).
final providerStatusProvider = FutureProvider.autoDispose<ProviderStatus?>((ref) async {
  final apiClientAsync = await ref.watch(apiClientProvider.future);
  final result = await apiClientAsync.get<ProviderStatus>(
    '/chat/provider-status',
    parse: (data) => ProviderStatus.fromJson(data as Map<String, dynamic>),
  );
  return result.data;
});

/// A manual light/dark toggle, mirroring the web client's theme switch.
/// Persisted via SecureStorage so it survives app restarts, same as the
/// other lightweight client-side preferences already stored there.
class ThemeModeController extends StateNotifier<ThemeMode> {
  ThemeModeController() : super(ThemeMode.system) {
    _restore();
  }

  Future<void> _restore() async {
    final saved = await SecureStorage.getThemeMode();
    if (saved == 'light') {
      state = ThemeMode.light;
    } else if (saved == 'dark') {
      state = ThemeMode.dark;
    }
  }

  Future<void> toggle() async {
    final next = state == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    state = next;
    await SecureStorage.setThemeMode(next == ThemeMode.dark ? 'dark' : 'light');
  }
}

final themeModeControllerProvider = StateNotifierProvider<ThemeModeController, ThemeMode>((ref) => ThemeModeController());
