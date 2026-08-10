import '../../../core/api/api_client.dart';
import 'agent_models.dart';

class AgentRepository {
  AgentRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<Agent>>> list() => _api.get<List<Agent>>(
        '/agents',
        parse: (data) => (data as List).map((a) => Agent.fromJson(a)).toList(),
      );

  Future<ApiResult<void>> delete(String id) => _api.delete('/agents/$id');

  Future<ApiResult<void>> clone(String id) => _api.post<void>(
        '/agents/$id/clone',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> toggleStatus(String id, String currentStatus) {
    final next = currentStatus == 'active' ? 'deactivate' : 'activate';
    return _api.post<void>('/agents/$id/$next', body: const {}, parse: (_) {});
  }

  /// Publishes an agent as a marketplace listing (name/description form).
  Future<ApiResult<Map<String, dynamic>>> publish(
    String agentId, {
    required String name,
    required String description,
  }) =>
      _api.post<Map<String, dynamic>>(
        '/marketplace/assets/from-agent/$agentId',
        body: {'name': name, 'description': description},
        parse: (data) => data as Map<String, dynamic>,
      );

  Future<ApiResult<AgentDetail>> detail(String id) => _api.get<AgentDetail>(
        '/agents/$id',
        parse: (data) => AgentDetail.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<List<AiProviderOption>>> providerOptions() => _api.get<List<AiProviderOption>>(
        '/chat/provider-options',
        parse: (data) => (data as List).map((p) => AiProviderOption.fromJson(p)).toList(),
      );

  Future<ApiResult<List<Workspace>>> workspaces(String orgId) => _api.get<List<Workspace>>(
        '/organizations/$orgId/workspaces',
        parse: (data) => (data as List).map((w) => Workspace.fromJson(w)).toList(),
      );

  /// Shared by create() and update() below — the request body shape is
  /// identical, only the HTTP verb/path differ (POST /agents to create,
  /// PATCH /agents/:id to update an existing one).
  Map<String, dynamic> _payload({
    required String name,
    required String description,
    required String personality,
    required String instructions,
    String? aiProvider,
    String? aiModel,
    String? orgId,
    String? workspaceId,
    required List<String> skillIds,
  }) =>
      {
        'name': name,
        'description': description,
        'personality': personality,
        'instructions': instructions,
        'aiProvider': aiProvider,
        'aiModel': aiModel,
        'orgId': orgId,
        'workspaceId': workspaceId,
        'skillIds': skillIds,
      };

  Future<ApiResult<Agent>> create({
    required String name,
    required String description,
    required String personality,
    required String instructions,
    String? aiProvider,
    String? aiModel,
    String? orgId,
    String? workspaceId,
    required List<String> skillIds,
  }) =>
      _api.post<Agent>(
        '/agents',
        body: _payload(
          name: name, description: description, personality: personality, instructions: instructions,
          aiProvider: aiProvider, aiModel: aiModel, orgId: orgId, workspaceId: workspaceId, skillIds: skillIds,
        ),
        parse: (data) => Agent.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<Agent>> update(
    String id, {
    required String name,
    required String description,
    required String personality,
    required String instructions,
    String? aiProvider,
    String? aiModel,
    String? orgId,
    String? workspaceId,
    required List<String> skillIds,
  }) =>
      _api.patch<Agent>(
        '/agents/$id',
        body: _payload(
          name: name, description: description, personality: personality, instructions: instructions,
          aiProvider: aiProvider, aiModel: aiModel, orgId: orgId, workspaceId: workspaceId, skillIds: skillIds,
        ),
        parse: (data) => Agent.fromJson(data as Map<String, dynamic>),
      );
}
