import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../agents/data/agent_models.dart';
import '../../agents/providers/agent_provider.dart' show agentRepositoryProvider;
import '../data/automation_models.dart';
import 'automation_provider.dart' show automationRepositoryProvider;

class AutomationBuilderState {
  final String name;
  final String description;
  final String agentId;
  final String triggerType;
  final Map<String, dynamic> triggerConfig;
  final List<AutomationStep> steps;
  final List<Agent> agents;
  final bool loading;
  final bool saving;
  final String? error;

  const AutomationBuilderState({
    this.name = '',
    this.description = '',
    this.agentId = '',
    this.triggerType = 'manual',
    this.triggerConfig = const {},
    this.steps = const [],
    this.agents = const [],
    this.loading = true,
    this.saving = false,
    this.error,
  });

  AutomationBuilderState copyWith({
    String? name,
    String? description,
    String? agentId,
    String? triggerType,
    Map<String, dynamic>? triggerConfig,
    List<AutomationStep>? steps,
    List<Agent>? agents,
    bool? loading,
    bool? saving,
    String? error,
    bool clearError = false,
  }) =>
      AutomationBuilderState(
        name: name ?? this.name,
        description: description ?? this.description,
        agentId: agentId ?? this.agentId,
        triggerType: triggerType ?? this.triggerType,
        triggerConfig: triggerConfig ?? this.triggerConfig,
        steps: steps ?? this.steps,
        agents: agents ?? this.agents,
        loading: loading ?? this.loading,
        saving: saving ?? this.saving,
        error: clearError ? null : (error ?? this.error),
      );
}

/// Handles both create (automationId == null) and edit — mirrors
/// AutomationBuilder.jsx doing the same with one component.
class AutomationBuilderController extends StateNotifier<AutomationBuilderState> {
  AutomationBuilderController(this._ref, this.automationId) : super(const AutomationBuilderState()) {
    _init();
  }
  final Ref _ref;
  final String? automationId;

  Future<void> _init() async {
    final agentRepo = _ref.read(agentRepositoryProvider);
    final agentsResult = await agentRepo.list();
    final agents = agentsResult.data ?? [];
    state = state.copyWith(agents: agents);

    if (automationId == null) {
      // New workflow — default to the user's first agent, same fallback the
      // Chat page and this builder both use, so tools are available out of
      // the box.
      state = state.copyWith(agentId: agents.isNotEmpty ? agents.first.id : '', loading: false);
      return;
    }

    final repo = _ref.read(automationRepositoryProvider);
    final result = await repo.detail(automationId!);
    if (!result.isSuccess || result.data == null) {
      state = state.copyWith(loading: false, error: result.error ?? 'Could not load this workflow.');
      return;
    }
    final a = result.data!;
    state = state.copyWith(
      name: a.name,
      description: a.description,
      agentId: a.agentId,
      triggerType: a.triggerType,
      triggerConfig: a.triggerConfig,
      steps: a.steps,
      loading: false,
    );
  }

  void setName(String v) => state = state.copyWith(name: v);
  void setDescription(String v) => state = state.copyWith(description: v);
  void setAgentId(String v) => state = state.copyWith(agentId: v);

  void setTriggerType(String v) => state = state.copyWith(triggerType: v, triggerConfig: {});

  void setScheduleFrequency(String v) => state = state.copyWith(triggerConfig: {...state.triggerConfig, 'frequency': v});
  void setScheduleCron(String v) => state = state.copyWith(triggerConfig: {...state.triggerConfig, 'cron': v});
  void setScheduleHour(int v) => state = state.copyWith(triggerConfig: {...state.triggerConfig, 'hour': v});

  void setWhatsappKeyword(String keyword) {
    final next = {...state.triggerConfig, 'keyword': keyword};
    if (keyword.isEmpty) {
      next.remove('filter');
    } else {
      next['filter'] = [
        [
          {'field': '{{messageText}}', 'op': 'contains', 'value': keyword}
        ]
      ];
    }
    state = state.copyWith(triggerConfig: next);
  }

  void setMetaAdsEventSubtype(String subtype) {
    final next = {...state.triggerConfig, 'eventSubtype': subtype};
    if (subtype.isEmpty) {
      next.remove('filter');
    } else {
      next['filter'] = [
        [
          {'field': '{{eventSubtype}}', 'op': 'equals', 'value': subtype}
        ]
      ];
    }
    state = state.copyWith(triggerConfig: next);
  }

  void addStep() => state = state.copyWith(steps: [...state.steps, AutomationStep(type: 'action', config: {})]);

  void updateStepType(int i, String type) {
    final next = List<AutomationStep>.from(state.steps);
    next[i] = AutomationStep(type: type, config: {});
    state = state.copyWith(steps: next);
  }

  /// Mutates the existing step's config in place (same object identity),
  /// unlike updateStepType above — the screen keys each step editor's text
  /// controllers off that identity (ObjectKey), so replacing the object on
  /// every keystroke here would tear down and recreate the controller (and
  /// lose cursor position/focus) on every character typed.
  ///
  /// A null value in `patch` removes that key entirely (e.g. clearing the
  /// condition step's optional "jump to step" field) rather than storing a
  /// literal null.
  void updateStepConfig(int i, Map<String, dynamic> patch) {
    final config = {...state.steps[i].config, ...patch};
    config.removeWhere((_, v) => v == null);
    state.steps[i].config = config;
    state = state.copyWith(steps: List<AutomationStep>.from(state.steps));
  }

  void removeStep(int i) {
    final next = List<AutomationStep>.from(state.steps)..removeAt(i);
    state = state.copyWith(steps: next);
  }

  void moveStep(int i, int dir) {
    final target = i + dir;
    if (target < 0 || target >= state.steps.length) return;
    final next = List<AutomationStep>.from(state.steps);
    final tmp = next[i];
    next[i] = next[target];
    next[target] = tmp;
    state = state.copyWith(steps: next);
  }

  Future<String?> save() async {
    if (state.name.trim().isEmpty) {
      state = state.copyWith(error: 'Give this workflow a name.');
      return null;
    }
    state = state.copyWith(saving: true, clearError: true);
    final repo = _ref.read(automationRepositoryProvider);
    if (automationId == null) {
      final result = await repo.create(
        name: state.name.trim(),
        description: state.description.trim(),
        triggerType: state.triggerType,
        triggerConfig: state.triggerConfig,
        agentId: state.agentId,
        steps: state.steps,
      );
      state = state.copyWith(saving: false, error: result.isSuccess ? null : (result.error ?? 'Could not save.'));
      return result.isSuccess ? (result.data?['id']?.toString() ?? '') : null;
    }
    final result = await repo.update(
      automationId!,
      name: state.name.trim(),
      description: state.description.trim(),
      triggerType: state.triggerType,
      triggerConfig: state.triggerConfig,
      agentId: state.agentId,
      steps: state.steps,
    );
    state = state.copyWith(saving: false, error: result.isSuccess ? null : (result.error ?? 'Could not save.'));
    return result.isSuccess ? automationId : null;
  }
}

final automationBuilderControllerProvider = StateNotifierProvider.autoDispose
    .family<AutomationBuilderController, AutomationBuilderState, String?>(
        (ref, automationId) => AutomationBuilderController(ref, automationId));
