import '../../../core/api/api_client.dart';
import 'marketplace_models.dart';

class MarketplaceRepository {
  MarketplaceRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<MarketplaceCategory>>> categories() => _api.get<List<MarketplaceCategory>>(
        '/marketplace/categories',
        parse: (data) => (data as List).map((c) => MarketplaceCategory.fromJson(c)).toList(),
      );

  Future<ApiResult<List<MarketplaceAsset>>> assets({String? q, String? type, String? category, String? sort}) =>
      _api.get<List<MarketplaceAsset>>(
        '/marketplace/assets',
        query: {
          if (q != null && q.isNotEmpty) 'q': q,
          if (type != null) 'type': type,
          if (category != null) 'category': category,
          if (sort != null) 'sort': sort,
        },
        parse: (data) => (data as List).map((a) => MarketplaceAsset.fromJson(a)).toList(),
      );

  Future<ApiResult<MarketplaceAssetDetail>> assetDetail(String id) => _api.get<MarketplaceAssetDetail>(
        '/marketplace/assets/$id',
        parse: (data) => MarketplaceAssetDetail.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<List<MarketplaceReview>>> reviews(String assetId, {String? sort}) =>
      _api.get<List<MarketplaceReview>>(
        '/marketplace/assets/$assetId/reviews',
        query: sort != null ? {'sort': sort} : null,
        parse: (data) => (data as List).map((r) => MarketplaceReview.fromJson(r)).toList(),
      );

  Future<ApiResult<void>> submitReview(String assetId, int rating, String reviewText) => _api.post<void>(
        '/marketplace/assets/$assetId/reviews',
        body: {'rating': rating, 'reviewText': reviewText},
        parse: (_) {},
      );

  Future<ApiResult<void>> voteHelpful(String reviewId) => _api.post<void>(
        '/marketplace/reviews/$reviewId/helpful',
        body: const {},
        parse: (_) {},
      );

  /// Installs a free asset directly. For paid assets, use purchase() instead
  /// — the server only lets a free/already-owned install go through here.
  Future<ApiResult<void>> install(String assetId) => _api.post<void>(
        '/marketplace/assets/$assetId/install',
        body: const {},
        parse: (_) {},
      );

  /// Returns the Stripe checkout URL to open in a browser — payment happens
  /// off-app, same as the web client's redirect-to-Stripe flow.
  Future<ApiResult<String?>> purchase(String assetId) => _api.post<String?>(
        '/marketplace/assets/$assetId/purchase',
        body: const {},
        parse: (data) => (data as Map<String, dynamic>)['url'] as String?,
      );

  Future<ApiResult<List<MarketplaceInstall>>> installs() => _api.get<List<MarketplaceInstall>>(
        '/marketplace/installs',
        parse: (data) => (data as List).map((i) => MarketplaceInstall.fromJson(i)).toList(),
      );

  Future<ApiResult<void>> updateInstall(String installId) => _api.post<void>(
        '/marketplace/installs/$installId/update',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> enableInstall(String installId) => _api.post<void>(
        '/marketplace/installs/$installId/enable',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> disableInstall(String installId) => _api.post<void>(
        '/marketplace/installs/$installId/disable',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> uninstall(String installId) => _api.delete<void>(
        '/marketplace/installs/$installId',
        parse: (_) {},
      );
}
