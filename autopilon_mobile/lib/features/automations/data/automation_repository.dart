import '../../../core/api/api_client.dart';
import 'automation_models.dart';

class AutomationRepository {
  AutomationRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<Automation>>> list() => _api.get<List<Automation>>(
        '/automations',
        parse: (data) => (data as List).map((a) => Automation.fromJson(a)).toList(),
      );

  Future<ApiResult<AutomationDashboard>> dashboard() => _api.get<AutomationDashboard>(
        '/automations/dashboard',
        parse: (data) => AutomationDashboard.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<AutomationDetail>> detail(String id) => _api.get<AutomationDetail>(
        '/automations/$id',
        parse: (data) => AutomationDetail.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<List<AutomationRun>>> runs(String id) => _api.get<List<AutomationRun>>(
        '/automations/$id/runs',
        parse: (data) => (data as List).map((r) => AutomationRun.fromJson(r)).toList(),
      );

  Future<ApiResult<Map<String, dynamic>>> create({
    required String name,
    required String description,
    required String triggerType,
    required Map<String, dynamic> triggerConfig,
    required String agentId,
    required List<AutomationStep> steps,
  }) =>
      _api.post<Map<String, dynamic>>(
        '/automations',
        body: {
          'name': name,
          'description': description,
          'triggerType': triggerType,
          'triggerConfig': triggerConfig,
          'agentId': agentId,
          'steps': steps.map((s) => s.toJson()).toList(),
        },
        parse: (data) => data as Map<String, dynamic>,
      );

  Future<ApiResult<void>> update(
    String id, {
    required String name,
    required String description,
    required String triggerType,
    required Map<String, dynamic> triggerConfig,
    required String agentId,
    required List<AutomationStep> steps,
  }) =>
      _api.patch<void>(
        '/automations/$id',
        body: {
          'name': name,
          'description': description,
          'triggerType': triggerType,
          'triggerConfig': triggerConfig,
          'agentId': agentId,
          'steps': steps.map((s) => s.toJson()).toList(),
        },
        parse: (_) {},
      );

  Future<ApiResult<void>> run(String id) => _api.post<void>('/automations/$id/run', body: const {}, parse: (_) {});

  Future<ApiResult<void>> activate(String id) => _api.post<void>('/automations/$id/activate', body: const {}, parse: (_) {});

  Future<ApiResult<void>> pause(String id) => _api.post<void>('/automations/$id/pause', body: const {}, parse: (_) {});

  Future<ApiResult<void>> delete(String id) => _api.delete<void>('/automations/$id', parse: (_) {});
}
