import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/automation_models.dart';
import '../data/automation_repository.dart';

final automationRepositoryProvider = Provider<AutomationRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return AutomationRepository(apiClientAsync.requireValue);
});

class AutomationsState {
  final List<Automation> automations;
  final AutomationDashboard? dashboard;
  final bool loading;
  final String? busyId;
  final String? error;

  const AutomationsState({
    this.automations = const [],
    this.dashboard,
    this.loading = true,
    this.busyId,
    this.error,
  });

  AutomationsState copyWith({
    List<Automation>? automations,
    AutomationDashboard? dashboard,
    bool? loading,
    String? busyId,
    bool clearBusy = false,
    String? error,
  }) =>
      AutomationsState(
        automations: automations ?? this.automations,
        dashboard: dashboard ?? this.dashboard,
        loading: loading ?? this.loading,
        busyId: clearBusy ? null : (busyId ?? this.busyId),
        error: error,
      );
}

class AutomationsController extends StateNotifier<AutomationsState> {
  AutomationsController(this._ref) : super(const AutomationsState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    state = state.copyWith(loading: true);
    final repo = _ref.read(automationRepositoryProvider);
    final listResult = await repo.list();
    if (!listResult.isSuccess) {
      state = state.copyWith(loading: false, error: listResult.error);
      return;
    }
    state = state.copyWith(automations: listResult.data ?? [], loading: false);
    final dashboardResult = await repo.dashboard();
    if (dashboardResult.isSuccess) state = state.copyWith(dashboard: dashboardResult.data);
  }

  Future<void> runNow(String id) async {
    state = state.copyWith(busyId: id);
    final repo = _ref.read(automationRepositoryProvider);
    try {
      await repo.run(id);
      await load();
    } finally {
      state = state.copyWith(clearBusy: true);
    }
  }

  Future<void> togglePause(Automation automation) async {
    state = state.copyWith(busyId: automation.id);
    final repo = _ref.read(automationRepositoryProvider);
    try {
      if (automation.status == 'active') {
        await repo.pause(automation.id);
      } else {
        await repo.activate(automation.id);
      }
      await load();
    } finally {
      state = state.copyWith(clearBusy: true);
    }
  }

  Future<void> delete(String id) async {
    final repo = _ref.read(automationRepositoryProvider);
    await repo.delete(id);
    await load();
  }
}

final automationsControllerProvider =
    StateNotifierProvider.autoDispose<AutomationsController, AutomationsState>((ref) => AutomationsController(ref));

/// Recent runs for one automation, loaded on demand when its row is
/// expanded — mirrors the "Runs" toggle in Automations.jsx.
class AutomationRunsController extends StateNotifier<AsyncValue<List<AutomationRun>>> {
  AutomationRunsController(this._ref, this.automationId) : super(const AsyncValue.loading()) {
    load();
  }
  final Ref _ref;
  final String automationId;

  Future<void> load() async {
    final repo = _ref.read(automationRepositoryProvider);
    final result = await repo.runs(automationId);
    state = AsyncValue.data(result.data ?? []);
  }
}

final automationRunsControllerProvider = StateNotifierProvider.autoDispose
    .family<AutomationRunsController, AsyncValue<List<AutomationRun>>, String>(
        (ref, id) => AutomationRunsController(ref, id));
