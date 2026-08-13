import 'dart:typed_data';
import '../../../core/api/api_client.dart';
import 'content_models.dart';

class ContentRepository {
  ContentRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<ContentAsset>>> listAssets({
    String? contentType,
    bool favoritesOnly = false,
    bool trashed = false,
    String? q,
  }) =>
      _api.get<List<ContentAsset>>(
        '/content',
        query: {
          if (contentType != null) 'contentType': contentType,
          if (favoritesOnly) 'favoritesOnly': 'true',
          if (trashed) 'trashed': 'true',
          if (q != null && q.isNotEmpty) 'q': q,
        },
        parse: (d) => (d as List).map((a) => ContentAsset.fromJson(a as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<List<CopyType>>> listCopyTypes() => _api.get<List<CopyType>>(
        '/content/copy-types',
        parse: (d) => (d as List).map((t) => CopyType.fromJson(t as Map<String, dynamic>)).toList(),
      );

  Future<ApiResult<ProviderStatus>> imageProviderStatus() => _api.get<ProviderStatus>(
        '/content/status',
        parse: (d) => ProviderStatus.fromJson((d as Map<String, dynamic>)['image']?['default'] as Map<String, dynamic>? ?? {}),
      );

  Future<ApiResult<List<ContentAsset>>> generateImage({
    required String prompt,
    String? size,
    int numImages = 1,
    String? title,
  }) =>
      _api.post<List<ContentAsset>>(
        '/content/generate/image',
        body: {'prompt': prompt, if (size != null) 'size': size, 'numImages': numImages, if (title != null && title.isNotEmpty) 'title': title},
        parse: (d) => ((d as Map<String, dynamic>)['assets'] as List).map((a) => ContentAsset.fromJson(a as Map<String, dynamic>)).toList(),
        // Image generation routinely takes longer than the client's normal
        // 20s timeout (OpenAI rendering time + network) — without this the
        // app reports "couldn't reach the server" for a request that's
        // actually still running and completes successfully server-side,
        // which is exactly what was observed testing this on a real device.
        receiveTimeout: const Duration(seconds: 90),
      );

  Future<ApiResult<ContentAsset>> generateCopy({
    required String contentType,
    required String brief,
    String? title,
  }) =>
      _api.post<ContentAsset>(
        '/content/generate/copy',
        body: {'contentType': contentType, 'brief': brief, if (title != null && title.isNotEmpty) 'title': title},
        parse: (d) => ContentAsset.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<ContentAsset>> generateVoiceover({
    required String text,
    String? voice,
    String? title,
  }) =>
      _api.post<ContentAsset>(
        '/content/generate/voiceover',
        body: {'text': text, if (voice != null) 'voice': voice, if (title != null && title.isNotEmpty) 'title': title},
        // Same reasoning as generateImage() — a longer script can take a
        // while to synthesize, so give it more headroom than the default.
        receiveTimeout: const Duration(seconds: 60),
        parse: (d) => ContentAsset.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<ContentAsset>> setFavorite(String assetId, bool favorite) => _api.patch<ContentAsset>(
        '/content/$assetId',
        body: {'favorite': favorite},
        parse: (d) => ContentAsset.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<void>> trash(String assetId) => _api.delete<void>('/content/$assetId', parse: (_) {});

  Future<ApiResult<ContentAsset>> restore(String assetId) =>
      _api.post<ContentAsset>('/content/$assetId/restore', body: const {}, parse: (d) => ContentAsset.fromJson(d as Map<String, dynamic>));

  Future<ApiResult<ContentAsset>> duplicate(String assetId) =>
      _api.post<ContentAsset>('/content/$assetId/duplicate', body: const {}, parse: (d) => ContentAsset.fromJson(d as Map<String, dynamic>));

  Future<ApiResult<void>> permanentlyDelete(String assetId) => _api.delete<void>('/content/$assetId/permanent', parse: (_) {});

  /// Media assets (image/voiceover) are stored through the existing File
  /// System, same as on web — there's no separate content-media endpoint,
  /// just the ordinary file content route.
  Future<ApiResult<Uint8List>> fetchFileBytes(String fileId) => _api.getBytes('/files/$fileId/content');
}
