import '../../../core/api/api_client.dart';
import '../../../core/models/models.dart';

class OrganizationRepository {
  OrganizationRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<Organization>>> list() => _api.get<List<Organization>>(
        '/organizations',
        parse: (data) => (data as List).map((o) => Organization.fromJson(o)).toList(),
      );

  Future<ApiResult<String?>> current() => _api.get<String?>(
        '/organizations/current',
        parse: (data) => data['orgId'] as String?,
      );

  Future<ApiResult<String?>> switchTo(String? orgId) => _api.post<String?>(
        '/organizations/switch',
        body: {'orgId': orgId},
        parse: (data) => data['orgId'] as String?,
      );
}
