import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/marketplace_models.dart';
import '../data/marketplace_repository.dart';

final marketplaceRepositoryProvider = Provider<MarketplaceRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return MarketplaceRepository(apiClientAsync.requireValue);
});

class MarketplaceBrowseState {
  final List<MarketplaceAsset> assets;
  final List<MarketplaceCategory> categories;
  final String query;
  final String? type;
  final bool loading;
  final String? error;

  const MarketplaceBrowseState({
    this.assets = const [],
    this.categories = const [],
    this.query = '',
    this.type,
    this.loading = true,
    this.error,
  });

  MarketplaceBrowseState copyWith({
    List<MarketplaceAsset>? assets,
    List<MarketplaceCategory>? categories,
    String? query,
    String? type,
    bool clearType = false,
    bool? loading,
    String? error,
    bool clearError = false,
  }) =>
      MarketplaceBrowseState(
        assets: assets ?? this.assets,
        categories: categories ?? this.categories,
        query: query ?? this.query,
        type: clearType ? null : (type ?? this.type),
        loading: loading ?? this.loading,
        error: clearError ? null : (error ?? this.error),
      );
}

class MarketplaceBrowseController extends StateNotifier<MarketplaceBrowseState> {
  MarketplaceBrowseController(this._ref) : super(const MarketplaceBrowseState()) {
    _init();
  }
  final Ref _ref;

  Future<void> _init() async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    final categoriesResult = await repo.categories();
    state = state.copyWith(categories: categoriesResult.data ?? []);
    await search();
  }

  Future<void> search([String? query]) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    state = state.copyWith(query: query ?? state.query, loading: true, clearError: true);
    final result = await repo.assets(q: state.query, type: state.type);
    if (result.isSuccess) {
      state = state.copyWith(assets: result.data ?? [], loading: false);
    } else {
      state = state.copyWith(loading: false, error: result.error);
    }
  }

  Future<void> filterByType(String? type) async {
    state = state.copyWith(type: type, clearType: type == null);
    await search();
  }
}

final marketplaceBrowseControllerProvider =
    StateNotifierProvider.autoDispose<MarketplaceBrowseController, MarketplaceBrowseState>(
        (ref) => MarketplaceBrowseController(ref));

class AssetDetailState {
  final MarketplaceAssetDetail? asset;
  final List<MarketplaceReview> reviews;
  final bool loading;
  final String? error;
  final bool actionBusy;
  final String? actionMessage;

  const AssetDetailState({
    this.asset,
    this.reviews = const [],
    this.loading = true,
    this.error,
    this.actionBusy = false,
    this.actionMessage,
  });

  AssetDetailState copyWith({
    MarketplaceAssetDetail? asset,
    List<MarketplaceReview>? reviews,
    bool? loading,
    String? error,
    bool? actionBusy,
    String? actionMessage,
    bool clearActionMessage = false,
  }) =>
      AssetDetailState(
        asset: asset ?? this.asset,
        reviews: reviews ?? this.reviews,
        loading: loading ?? this.loading,
        error: error ?? this.error,
        actionBusy: actionBusy ?? this.actionBusy,
        actionMessage: clearActionMessage ? null : (actionMessage ?? this.actionMessage),
      );
}

/// Per-asset detail + reviews + install/purchase actions, keyed by asset id
/// so navigating between assets doesn't reuse stale state.
class AssetDetailController extends StateNotifier<AssetDetailState> {
  AssetDetailController(this._ref, this.assetId) : super(const AssetDetailState()) {
    load();
  }
  final Ref _ref;
  final String assetId;

  Future<void> load() async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    state = state.copyWith(loading: true);
    final assetResult = await repo.assetDetail(assetId);
    if (!assetResult.isSuccess) {
      state = state.copyWith(loading: false, error: assetResult.error);
      return;
    }
    final reviewsResult = await repo.reviews(assetId);
    state = state.copyWith(
      asset: assetResult.data,
      reviews: reviewsResult.data ?? [],
      loading: false,
    );
  }

  /// Returns a Stripe checkout URL to open when the asset is paid; null when
  /// it installed directly (free) or the action failed (see actionMessage).
  Future<String?> installOrBuy() async {
    final asset = state.asset;
    if (asset == null) return null;
    final repo = _ref.read(marketplaceRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    if (asset.isFree) {
      final result = await repo.install(assetId);
      state = state.copyWith(
        actionBusy: false,
        actionMessage: result.isSuccess ? 'Installed.' : (result.error ?? 'Install failed.'),
      );
      return null;
    }
    final result = await repo.purchase(assetId);
    state = state.copyWith(
      actionBusy: false,
      actionMessage: result.isSuccess ? null : (result.error ?? 'Could not start checkout.'),
    );
    return result.data;
  }

  Future<void> submitReview(int rating, String reviewText) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.submitReview(assetId, rating, reviewText);
    state = state.copyWith(
      actionBusy: false,
      actionMessage: result.isSuccess ? 'Review submitted.' : (result.error ?? 'Could not submit review.'),
    );
    if (result.isSuccess) await load();
  }

  Future<void> voteHelpful(String reviewId) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    await repo.voteHelpful(reviewId);
    await load();
  }
}

final assetDetailControllerProvider = StateNotifierProvider.autoDispose
    .family<AssetDetailController, AssetDetailState, String>((ref, assetId) => AssetDetailController(ref, assetId));

class MyInstallsState {
  final List<MarketplaceInstall> installs;
  final bool loading;
  final String? error;
  const MyInstallsState({this.installs = const [], this.loading = true, this.error});
  MyInstallsState copyWith({List<MarketplaceInstall>? installs, bool? loading, String? error}) => MyInstallsState(
        installs: installs ?? this.installs,
        loading: loading ?? this.loading,
        error: error,
      );
}

class MyInstallsController extends StateNotifier<MyInstallsState> {
  MyInstallsController(this._ref) : super(const MyInstallsState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    final result = await repo.installs();
    state = result.isSuccess
        ? MyInstallsState(installs: result.data ?? [], loading: false)
        : MyInstallsState(loading: false, error: result.error);
  }

  Future<void> update(String installId) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    await repo.updateInstall(installId);
    await load();
  }

  Future<void> toggleEnabled(String installId, bool enable) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    if (enable) {
      await repo.enableInstall(installId);
    } else {
      await repo.disableInstall(installId);
    }
    await load();
  }

  Future<void> uninstall(String installId) async {
    final repo = _ref.read(marketplaceRepositoryProvider);
    await repo.uninstall(installId);
    await load();
  }
}

final myInstallsControllerProvider =
    StateNotifierProvider.autoDispose<MyInstallsController, MyInstallsState>((ref) => MyInstallsController(ref));
