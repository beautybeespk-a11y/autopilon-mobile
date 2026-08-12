import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_client.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/content_models.dart';
import '../data/content_repository.dart';

final contentRepositoryProvider = Provider<ContentRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return ContentRepository(apiClientAsync.requireValue);
});

enum ContentFilter { all, images, copy, voiceovers, favorites }

const _copyContentTypes = [
  'caption', 'hashtags', 'ad_copy', 'product_description', 'blog', 'email', 'headline', 'hook', 'cta', 'script', 'seo_content', 'ugc_script',
];

class ContentState {
  final ContentFilter filter;
  final List<ContentAsset> assets;
  final bool loading;
  final String? error;

  const ContentState({this.filter = ContentFilter.all, this.assets = const [], this.loading = true, this.error});

  ContentState copyWith({ContentFilter? filter, List<ContentAsset>? assets, bool? loading, String? error, bool clearError = false}) =>
      ContentState(
        filter: filter ?? this.filter,
        assets: assets ?? this.assets,
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
      );
}

/// Mirrors FilesController's shape (one controller, one load() that reads
/// state.filter) — the Content Studio equivalent of the Files list, scoped
/// to what's practical as a lightweight mobile creation surface rather than
/// a full desktop-editor copy (no templates/brand-voice/version-history
/// management here; those stay web-only for this pass, same principle
/// files_provider.dart already applied to sharing/version history).
class ContentController extends StateNotifier<ContentState> {
  ContentController(this._ref) : super(const ContentState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    final repo = _ref.read(contentRepositoryProvider);
    final result = await repo.listAssets(
      contentType: switch (state.filter) {
        ContentFilter.images => 'image',
        ContentFilter.voiceovers => 'voiceover',
        _ => null,
      },
      favoritesOnly: state.filter == ContentFilter.favorites,
    );
    var assets = result.data ?? [];
    if (state.filter == ContentFilter.copy) {
      assets = assets.where((a) => _copyContentTypes.contains(a.contentType)).toList();
    }
    state = state.copyWith(assets: assets, loading: false, error: result.error);
  }

  void setFilter(ContentFilter filter) {
    state = state.copyWith(filter: filter);
    load();
  }

  Future<void> toggleFavorite(ContentAsset asset) async {
    final result = await _ref.read(contentRepositoryProvider).setFavorite(asset.id, !asset.favorite);
    if (result.isSuccess) load();
  }

  Future<ApiResult<void>> trashAsset(ContentAsset asset) async {
    final result = await _ref.read(contentRepositoryProvider).trash(asset.id);
    if (result.isSuccess) load();
    return result;
  }

  Future<ApiResult<ContentAsset>> duplicateAsset(ContentAsset asset) async {
    final result = await _ref.read(contentRepositoryProvider).duplicate(asset.id);
    if (result.isSuccess) load();
    return result;
  }
}

final contentControllerProvider = StateNotifierProvider.autoDispose<ContentController, ContentState>((ref) => ContentController(ref));
