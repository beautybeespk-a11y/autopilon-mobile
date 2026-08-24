import '../../../core/api/api_client.dart';
import 'integration_models.dart';

class IntegrationRepository {
  IntegrationRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<IntegrationItem>>> list() => _api.get<List<IntegrationItem>>(
        '/integrations',
        parse: (data) => (data as List).map((e) => IntegrationItem.fromJson(e as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<void>> connectManual(String provider, Map<String, String> fields) => _api.post<void>(
        '/integrations/$provider/connect',
        body: fields,
        parse: (_) {},
      );

  // Meta's own routes live under /integrations/meta/... while the catalog
  // entry (and every other API response) calls the provider "meta_ads" —
  // same alias the web client applies in Integrations.jsx's disconnect().
  Future<ApiResult<void>> disconnect(String provider) => _api.post<void>(
        '/integrations/${provider == 'meta_ads' ? 'meta' : provider}/disconnect',
        body: const {},
        parse: (_) {},
      );

  /// Full URL for a redirect-type integration's connect endpoint —
  /// `connectPath` from the catalog (e.g. "/api/integrations/meta/connect")
  /// is already an absolute path rooted at the API host, same as the web
  /// client's `window.location.href = it.connectPath`. ApiClient.baseUrl
  /// already ends in "/api", so this resolves against the bare origin to
  /// avoid doubling that segment.
  String oauthUrl(String connectPath) {
    final origin = Uri.parse(ApiClient.baseUrl);
    return Uri(scheme: origin.scheme, host: origin.host, port: origin.hasPort ? origin.port : null, path: connectPath).toString();
  }
}
