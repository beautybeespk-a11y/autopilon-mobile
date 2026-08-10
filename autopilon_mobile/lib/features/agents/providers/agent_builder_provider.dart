import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/models/models.dart';
import '../../organizations/providers/organization_provider.dart';
import '../data/agent_models.dart';
import '../data/agent_repository.dart';
import 'agent_provider.dart' show agentRepositoryProvider;

class AgentBuilderState {
  final String name;
  final String description;
  final String personality; // "Professional" | "Friendly" | "Creative" | "Direct" | "Custom" — Title Case, matches web
  final String instructions;
  final String aiProvider; // '' = platform default
  final String aiModel;
  final String orgId; // '' = personal
  final String workspaceId; // '' = whole organization
  final Set<String> skillIds;
  final List<AiProviderOption> providerOptions;
  final List<Workspace> orgWorkspaces;
  final bool loading;
  final bool saving;
  final String? error;

  const AgentBuilderState({
    this.name = '',
    this.description = '',
    this.personality = 'Professional',
    this.instructions = '',
    this.aiProvider = '',
    this.aiModel = '',
    this.orgId = '',
    this.workspaceId = '',
    this.skillIds = const {},
    this.providerOptions = const [],
    this.orgWorkspaces = const [],
    this.loading = true,
    this.saving = false,
    this.error,
  });

  AgentBuilderState copyWith({
    String? name,
    String? description,
    String? personality,
    String? instructions,
    String? aiProvider,
    String? aiModel,
    String? orgId,
    String? workspaceId,
    Set<String>? skillIds,
    List<AiProviderOption>? providerOptions,
    List<Workspace>? orgWorkspaces,
    bool? loading,
    bool? saving,
    String? error,
    bool clearError = false,
  }) =>
      AgentBuilderState(
        name: name ?? this.name,
        description: description ?? this.description,
        personality: personality ?? this.personality,
        instructions: instructions ?? this.instructions,
        aiProvider: aiProvider ?? this.aiProvider,
        aiModel: aiModel ?? this.aiModel,
        orgId: orgId ?? this.orgId,
        workspaceId: workspaceId ?? this.workspaceId,
        skillIds: skillIds ?? this.skillIds,
        providerOptions: providerOptions ?? this.providerOptions,
        orgWorkspaces: orgWorkspaces ?? this.orgWorkspaces,
        loading: loading ?? this.loading,
        saving: saving ?? this.saving,
        error: clearError ? null : (error ?? this.error),
      );
}

/// Handles both create (agentId == null) and edit (agentId set) — mirrors
/// AgentBuilder.jsx doing the same with a single component keyed off a
/// route param. Family-keyed by agentId so navigating between "New agent"
/// and editing different agents never reuses stale form state.
class AgentBuilderController extends StateNotifier<AgentBuilderState> {
  AgentBuilderController(this._ref, this.agentId) : super(const AgentBuilderState()) {
    _init();
  }
  final Ref _ref;
  final String? agentId;

  Future<void> _init() async {
    final repo = _ref.read(agentRepositoryProvider);
    final providersResult = await repo.providerOptions();
    state = state.copyWith(providerOptions: providersResult.data ?? []);

    if (agentId == null) {
      state = state.copyWith(loading: false);
      return;
    }

    final detailResult = await repo.detail(agentId!);
    if (!detailResult.isSuccess || detailResult.data == null) {
      state = state.copyWith(loading: false, error: detailResult.error ?? 'Could not load this agent.');
      return;
    }
    final a = detailResult.data!;
    state = state.copyWith(
      name: a.name,
      description: a.description ?? '',
      personality: _titleCase(a.personality),
      instructions: a.instructions ?? '',
      aiProvider: a.aiProvider ?? '',
      aiModel: a.aiModel ?? '',
      orgId: a.orgId ?? '',
      workspaceId: a.workspaceId ?? '',
      skillIds: a.skillIds.toSet(),
      loading: false,
    );
    if (a.orgId != null && a.orgId!.isNotEmpty) await loadWorkspaces(a.orgId!);
  }

  String _titleCase(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

  /// Orgs the signed-in user can share an agent with — owner/admin only,
  /// matching manageableOrgs in AgentBuilder.jsx. Reuses the already-loaded
  /// org list rather than a separate fetch.
  List<Organization> get manageableOrgs =>
      _ref.read(organizationControllerProvider).organizations.where((o) => o.myRole == 'owner' || o.myRole == 'admin').toList();

  void setName(String v) => state = state.copyWith(name: v);
  void setDescription(String v) => state = state.copyWith(description: v);
  void setPersonality(String v) => state = state.copyWith(personality: v);
  void setInstructions(String v) => state = state.copyWith(instructions: v);
  void setAiModel(String v) => state = state.copyWith(aiModel: v);

  void setAiProvider(String v) => state = state.copyWith(aiProvider: v, aiModel: '');

  void toggleSkill(String skillId) {
    final next = Set<String>.from(state.skillIds);
    if (!next.remove(skillId)) next.add(skillId);
    state = state.copyWith(skillIds: next);
  }

  Future<void> setOrgId(String orgId) async {
    state = state.copyWith(orgId: orgId, workspaceId: '', orgWorkspaces: const []);
    if (orgId.isNotEmpty) await loadWorkspaces(orgId);
  }

  void setWorkspaceId(String v) => state = state.copyWith(workspaceId: v);

  Future<void> loadWorkspaces(String orgId) async {
    final repo = _ref.read(agentRepositoryProvider);
    final result = await repo.workspaces(orgId);
    state = state.copyWith(orgWorkspaces: result.data ?? []);
  }

  /// Returns the saved agent's id on success (for navigation), null on
  /// failure (state.error is set for the screen to show).
  Future<String?> save() async {
    if (state.name.trim().isEmpty) {
      state = state.copyWith(error: 'Give this agent a name.');
      return null;
    }
    state = state.copyWith(saving: true, clearError: true);
    final repo = _ref.read(agentRepositoryProvider);
    final result = agentId == null
        ? await repo.create(
            name: state.name.trim(),
            description: state.description.trim(),
            personality: state.personality.toLowerCase(),
            instructions: state.instructions.trim(),
            aiProvider: state.aiProvider.isEmpty ? null : state.aiProvider,
            aiModel: state.aiModel.trim().isEmpty ? null : state.aiModel.trim(),
            orgId: state.orgId.isEmpty ? null : state.orgId,
            workspaceId: state.workspaceId.isEmpty ? null : state.workspaceId,
            skillIds: state.skillIds.toList(),
          )
        : await repo.update(
            agentId!,
            name: state.name.trim(),
            description: state.description.trim(),
            personality: state.personality.toLowerCase(),
            instructions: state.instructions.trim(),
            aiProvider: state.aiProvider.isEmpty ? null : state.aiProvider,
            aiModel: state.aiModel.trim().isEmpty ? null : state.aiModel.trim(),
            orgId: state.orgId.isEmpty ? null : state.orgId,
            workspaceId: state.workspaceId.isEmpty ? null : state.workspaceId,
            skillIds: state.skillIds.toList(),
          );
    if (result.isSuccess) {
      state = state.copyWith(saving: false);
      return result.data?.id ?? agentId ?? '';
    }
    state = state.copyWith(saving: false, error: result.error ?? 'Could not save this agent.');
    return null;
  }
}

final agentBuilderControllerProvider = StateNotifierProvider.autoDispose
    .family<AgentBuilderController, AgentBuilderState, String?>((ref, agentId) => AgentBuilderController(ref, agentId));
