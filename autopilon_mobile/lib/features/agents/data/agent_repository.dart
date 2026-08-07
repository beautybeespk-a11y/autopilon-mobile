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
}
