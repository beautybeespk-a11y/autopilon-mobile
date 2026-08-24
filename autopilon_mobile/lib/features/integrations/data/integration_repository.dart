import '../../../core/api/api_client.dart';
import 'integration_models.dart';

class IntegrationRepository {
  IntegrationRepository(this._client);
  final ApiClient _client;

  Future<ApiResult<List<IntegrationItem>>> list() => _client.get<List<IntegrationItem>>(
        '/integrations',
        parse: (data) => (data as List).map((e) => IntegrationItem.fromJson(e as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<void>> manualConnect(String provider, Map<String, String> fields) =>
      _client.post<void>('/integrations/$provider/connect', body: fields, parse: (_) {});

  // Meta's routes live under /integrations/meta/... while its catalog entry
  // is "meta_ads" — same alias the web client applies (Integrations.jsx's
  // connect()/disconnect()) so both clients hit the same server route.
  Future<ApiResult<void>> disconnect(String provider) => _client.post<void>(
        '/integrations/${provider == 'meta_ads' ? 'meta' : provider}/disconnect',
        body: const {},
        parse: (_) {},
      );
}
