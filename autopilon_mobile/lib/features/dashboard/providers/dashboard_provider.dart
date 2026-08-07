import 'package:flutter_riverpod/flutter_riverpod.dart';
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

  const DashboardState({
    this.dashboard,
    this.analytics,
    this.cost,
    this.loading = true,
    this.error,
  });

  DashboardState copyWith({
    DashboardData? dashboard,
    AnalyticsData? analytics,
    CostData? cost,
    bool? loading,
    String? error,
  }) =>
      DashboardState(
        dashboard: dashboard ?? this.dashboard,
        analytics: analytics ?? this.analytics,
        cost: cost ?? this.cost,
        loading: loading ?? this.loading,
        error: error,
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

  Future<void> _load() async {
    final orgId = _activeOrgId;
    if (orgId == null) {
      state = state.copyWith(loading: false, error: 'No organization selected');
      return;
    }
    final repo = _ref.read(dashboardRepositoryProvider);

    final dashboardResult = await repo.dashboard(orgId);
    if (!dashboardResult.isSuccess) {
      state = state.copyWith(loading: false, error: dashboardResult.error);
      return;
    }
    state = state.copyWith(dashboard: dashboardResult.data, loading: false);

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
