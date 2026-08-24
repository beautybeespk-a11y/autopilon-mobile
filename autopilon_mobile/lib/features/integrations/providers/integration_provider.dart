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
  final bool actionBusy;

  const IntegrationState({this.items = const [], this.loading = true, this.error, this.actionBusy = false});

  IntegrationState copyWith({List<IntegrationItem>? items, bool? loading, String? error, bool? actionBusy}) =>
      IntegrationState(
        items: items ?? this.items,
        loading: loading ?? this.loading,
        error: error,
        actionBusy: actionBusy ?? this.actionBusy,
      );
}

class IntegrationController extends StateNotifier<IntegrationState> {
  IntegrationController(this._ref) : super(const IntegrationState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    state = state.copyWith(loading: true, error: null);
    final repo = _ref.read(integrationRepositoryProvider);
    final result = await repo.list();
    if (result.isSuccess) {
      state = state.copyWith(items: result.data ?? [], loading: false);
    } else {
      state = state.copyWith(loading: false, error: result.error);
    }
  }

  Future<String?> manualConnect(String provider, Map<String, String> fields) async {
    state = state.copyWith(actionBusy: true);
    final repo = _ref.read(integrationRepositoryProvider);
    final result = await repo.manualConnect(provider, fields);
    state = state.copyWith(actionBusy: false);
    if (result.isSuccess) {
      await load();
      return null;
    }
    return result.error ?? 'Could not connect.';
  }

  Future<String?> disconnect(String provider) async {
    state = state.copyWith(actionBusy: true);
    final repo = _ref.read(integrationRepositoryProvider);
    final result = await repo.disconnect(provider);
    state = state.copyWith(actionBusy: false);
    if (result.isSuccess) {
      await load();
      return null;
    }
    return result.error ?? 'Could not disconnect.';
  }
}

final integrationControllerProvider =
    StateNotifierProvider.autoDispose<IntegrationController, IntegrationState>((ref) => IntegrationController(ref));
