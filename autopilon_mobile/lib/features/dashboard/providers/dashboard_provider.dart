import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/cache/local_cache.dart';
import '../../auth/providers/auth_provider.dart';
import '../../organizations/providers/organization_provider.dart';
import '../data/dashboard_models.dart';
import '../data/dashboard_repository.dart';

final dashboardRepositoryProvider = Provider<DashboardRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return DashboardRepository(apiClientAsync.requireValue);
});

class DashboardState {
  final DashboardData? dashboard;
  final AnalyticsData? analytics;
  final CostData? cost;
  final bool loading;
  final String? error;
  // Set only when `dashboard` came from LocalCache (offline fallback)
  // rather than a live server response — the screen uses this to show a
  // "showing saved data from X" note instead of pretending it's live.
  final DateTime? cachedAt;

  const DashboardState({
    this.dashboard,
    this.analytics,
    this.cost,
    this.loading = true,
    this.error,
    this.cachedAt,
  });

  DashboardState copyWith({
    DashboardData? dashboard,
    AnalyticsData? analytics,
    CostData? cost,
    bool? loading,
    String? error,
    DateTime? cachedAt,
    bool clearCachedAt = false,
  }) =>
      DashboardState(
        dashboard: dashboard ?? this.dashboard,
        analytics: analytics ?? this.analytics,
        cost: cost ?? this.cost,
        loading: loading ?? this.loading,
        error: error,
        cachedAt: clearCachedAt ? null : (cachedAt ?? this.cachedAt),
      );
}

/// Mirrors the web client's OrganizationDashboard.jsx: loads the dashboard
/// endpoint (required — errors surface), plus analytics and cost endpoints
/// (optional — failures are swallowed, same as the web client's .catch(() => {})).
class DashboardController extends StateNotifier<DashboardState> {
  DashboardController(this._ref) : super(const DashboardState()) {
    _load();
  }
  final Ref _ref;

  String? get _activeOrgId => _ref.read(organizationControllerProvider).activeOrgId;

  String _cacheKey(String orgId) => 'dashboard_$orgId';

  Future<void> _load() async {
    final orgId = _activeOrgId;
    if (orgId == null) {
      state = state.copyWith(loading: false, error: 'No organization selected');
      return;
    }
    final repo = _ref.read(dashboardRepositoryProvider);

    final dashboardResult = await repo.dashboard(orgId);
    if (!dashboardResult.isSuccess) {
      // Likely offline — fall back to whatever was last successfully
      // loaded for this org, if anything, rather than a bare error screen.
      final cached = await LocalCache.load(_cacheKey(orgId));
      if (cached != null) {
        state = state.copyWith(
          dashboard: DashboardData.fromJson(cached.$1),
          loading: false,
          cachedAt: cached.$2,
          error: null,
        );
        return;
      }
      state = state.copyWith(loading: false, error: dashboardResult.error);
      return;
    }
    state = state.copyWith(dashboard: dashboardResult.data, loading: false, clearCachedAt: true);
    await LocalCache.save(_cacheKey(orgId), dashboardResult.data!.toJson());

    final analyticsResult = await repo.analytics(orgId);
    if (analyticsResult.isSuccess) {
      state = state.copyWith(analytics: analyticsResult.data);
    }

    final costResult = await repo.cost(orgId);
    if (costResult.isSuccess) {
      state = state.copyWith(cost: costResult.data);
    }
  }

  Future<void> refresh() => _load();
}

final dashboardControllerProvider =
    StateNotifierProvider.autoDispose<DashboardController, DashboardState>(
        (ref) => DashboardController(ref));
