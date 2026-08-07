import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/agent_models.dart';
import '../data/agent_repository.dart';

final agentRepositoryProvider = Provider<AgentRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return AgentRepository(apiClientAsync.requireValue);
});

class AgentsState {
  final List<Agent> agents;
  final bool loading;
  final String? busyId;
  final String? error;

  const AgentsState({
    this.agents = const [],
    this.loading = true,
    this.busyId,
    this.error,
  });

  AgentsState copyWith({
    List<Agent>? agents,
    bool? loading,
    String? busyId,
    bool clearBusy = false,
    String? error,
  }) =>
      AgentsState(
        agents: agents ?? this.agents,
        loading: loading ?? this.loading,
        busyId: clearBusy ? null : (busyId ?? this.busyId),
        error: error,
      );
}

class AgentsController extends StateNotifier<AgentsState> {
  AgentsController(this._ref) : super(const AgentsState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    state = state.copyWith(loading: true);
    final repo = _ref.read(agentRepositoryProvider);
    final result = await repo.list();
    if (result.isSuccess) {
      state = state.copyWith(agents: result.data ?? [], loading: false);
    } else {
      state = state.copyWith(loading: false, error: result.error);
    }
  }

  Future<void> delete(String id) async {
    final repo = _ref.read(agentRepositoryProvider);
    await repo.delete(id);
    await load();
  }

  Future<void> clone(String id) async {
    state = state.copyWith(busyId: id);
    final repo = _ref.read(agentRepositoryProvider);
    try {
      await repo.clone(id);
      await load();
    } finally {
      state = state.copyWith(clearBusy: true);
    }
  }

  Future<void> toggleStatus(Agent agent) async {
    state = state.copyWith(busyId: agent.id);
    final repo = _ref.read(agentRepositoryProvider);
    try {
      await repo.toggleStatus(agent.id, agent.status);
      await load();
    } finally {
      state = state.copyWith(clearBusy: true);
    }
  }

  Future<bool> publish(String agentId, String name, String description) async {
    final repo = _ref.read(agentRepositoryProvider);
    final result = await repo.publish(agentId, name: name, description: description);
    return result.isSuccess;
  }
}

final agentsControllerProvider =
    StateNotifierProvider.autoDispose<AgentsController, AgentsState>((ref) => AgentsController(ref));
