import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/integration_models.dart';
import '../data/integration_repository.dart';

final integrationRepositoryProvider = Provider<IntegrationRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return IntegrationRepository(apiClientAsync.requireValue);
});

class IntegrationState {
  final List<IntegrationItem> items;
  final bool loading;
  final String? error;

  const IntegrationState({this.items = const [], this.loading = true, this.error});

  IntegrationState copyWith({List<IntegrationItem>? items, bool? loading, String? error}) => IntegrationState(
        items: items ?? this.items,
        loading: loading ?? this.loading,
        error: error,
      );
}

class IntegrationController extends StateNotifier<IntegrationState> {
  IntegrationController(this._ref) : super(const IntegrationState()) {
    _load();
  }
  final Ref _ref;

  Future<void> _load() async {
    final repo = _ref.read(integrationRepositoryProvider);
    final result = await repo.list();
    if (result.isSuccess) {
      state = state.copyWith(items: result.data ?? [], loading: false, error: null);
    } else {
      state = state.copyWith(loading: false, error: result.error);
    }
  }

  Future<void> refresh() => _load();

  /// Returns an error message on failure, null on success — mirrors the
  /// billing controller's ApiResult-to-nullable-string pattern so the sheet
  /// UI can show it inline without a separate error field on the shared
  /// list state.
  Future<String?> connectManual(String provider, Map<String, String> fields) async {
    final repo = _ref.read(integrationRepositoryProvider);
    final result = await repo.connectManual(provider, fields);
    if (result.isSuccess) {
      await _load();
      return null;
    }
    return result.error ?? 'Could not connect.';
  }

  Future<void> disconnect(String provider) async {
    final repo = _ref.read(integrationRepositoryProvider);
    await repo.disconnect(provider);
    await _load();
  }
}

final integrationControllerProvider =
    StateNotifierProvider.autoDispose<IntegrationController, IntegrationState>((ref) => IntegrationController(ref));
