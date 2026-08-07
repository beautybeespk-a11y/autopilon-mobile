import '../../../core/api/api_client.dart';
import 'dashboard_models.dart';

class DashboardRepository {
  DashboardRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<DashboardData>> dashboard(String orgId) => _api.get<DashboardData>(
        '/organizations/$orgId/dashboard',
        parse: (data) => DashboardData.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<AnalyticsData>> analytics(String orgId) => _api.get<AnalyticsData>(
        '/organizations/$orgId/analytics',
        parse: (data) => AnalyticsData.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<CostData>> cost(String orgId) => _api.get<CostData>(
        '/organizations/$orgId/cost',
        parse: (data) => CostData.fromJson(data as Map<String, dynamic>),
      );
}
