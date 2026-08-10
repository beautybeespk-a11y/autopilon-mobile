import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/data/dashboard_models.dart' show CostData;
import '../../organizations/providers/organization_provider.dart';
import '../data/billing_models.dart';
import '../data/billing_repository.dart';

final billingRepositoryProvider = Provider<BillingRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return BillingRepository(apiClientAsync.requireValue);
});

class BillingState {
  final List<BillingPlan> plans;
  final BillingDashboard? dashboard;
  final CostData? cost;
  final CreditInfo? credits;
  final List<BillingApiKey> apiKeys;
  final bool loading;
  final String? error;
  final bool actionBusy;
  final String? actionMessage;

  const BillingState({
    this.plans = const [],
    this.dashboard,
    this.cost,
    this.credits,
    this.apiKeys = const [],
    this.loading = true,
    this.error,
    this.actionBusy = false,
    this.actionMessage,
  });

  BillingState copyWith({
    List<BillingPlan>? plans,
    BillingDashboard? dashboard,
    CostData? cost,
    CreditInfo? credits,
    List<BillingApiKey>? apiKeys,
    bool? loading,
    String? error,
    bool? actionBusy,
    String? actionMessage,
    bool clearActionMessage = false,
  }) =>
      BillingState(
        plans: plans ?? this.plans,
        dashboard: dashboard ?? this.dashboard,
        cost: cost ?? this.cost,
        credits: credits ?? this.credits,
        apiKeys: apiKeys ?? this.apiKeys,
        loading: loading ?? this.loading,
        error: error,
        actionBusy: actionBusy ?? this.actionBusy,
        actionMessage: clearActionMessage ? null : (actionMessage ?? this.actionMessage),
      );
}

/// Billing is org-scoped and owner/admin-only server-side (requireOwnerOrAdmin
/// in server/routes/billing.js) — mirrors that by reading the active org from
/// OrganizationController the same way DashboardController does, and the
/// screen checks myRole before rendering any billing UI.
class BillingController extends StateNotifier<BillingState> {
  BillingController(this._ref) : super(const BillingState()) {
    _load();
  }
  final Ref _ref;

  String? get activeOrgId => _ref.read(organizationControllerProvider).activeOrgId;

  Future<void> _load() async {
    final orgId = activeOrgId;
    if (orgId == null) {
      state = state.copyWith(loading: false, error: 'Switch to an organization to view billing.');
      return;
    }
    final repo = _ref.read(billingRepositoryProvider);
    final plansResult = await repo.plans();
    final dashboardResult = await repo.billing(orgId);
    if (!dashboardResult.isSuccess) {
      state = state.copyWith(loading: false, error: dashboardResult.error);
      return;
    }
    state = state.copyWith(plans: plansResult.data ?? [], dashboard: dashboardResult.data, loading: false);

    final creditsResult = await repo.credits(orgId);
    if (creditsResult.isSuccess) state = state.copyWith(credits: creditsResult.data);

    final costResult = await repo.cost(orgId);
    if (costResult.isSuccess) state = state.copyWith(cost: costResult.data);

    final keysResult = await repo.apiKeys(orgId);
    if (keysResult.isSuccess) state = state.copyWith(apiKeys: keysResult.data ?? []);
  }

  Future<void> refresh() => _load();

  Future<String?> startCheckout(String planId) async {
    final orgId = activeOrgId;
    if (orgId == null) return null;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.checkout(orgId, planId);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? null : result.error);
    return result.data;
  }

  Future<String?> openPortal() async {
    final orgId = activeOrgId;
    if (orgId == null) return null;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.portal(orgId);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? null : result.error);
    return result.data;
  }

  Future<void> cancelSubscription() async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.cancelSubscription(orgId);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? 'Subscription will cancel at period end.' : result.error);
    if (result.isSuccess) await _load();
  }

  Future<void> resumeSubscription() async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.resumeSubscription(orgId);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? 'Subscription resumed.' : result.error);
    if (result.isSuccess) await _load();
  }

  Future<void> setBillingMode(String mode) async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.setBillingMode(orgId, mode);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? null : result.error);
    if (result.isSuccess) await _load();
  }

  Future<void> addApiKey(String provider, String apiKey) async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.addApiKey(orgId, provider, apiKey);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? 'Key saved.' : result.error);
    if (result.isSuccess) await _load();
  }

  Future<void> removeApiKey(String provider) async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    await repo.removeApiKey(orgId, provider);
    await _load();
  }

  Future<void> redeemCoupon(String code) async {
    final orgId = activeOrgId;
    if (orgId == null) return;
    final repo = _ref.read(billingRepositoryProvider);
    state = state.copyWith(actionBusy: true, clearActionMessage: true);
    final result = await repo.redeemCoupon(orgId, code);
    state = state.copyWith(actionBusy: false, actionMessage: result.isSuccess ? 'Coupon applied.' : (result.error ?? 'Could not redeem coupon.'));
    if (result.isSuccess) await _load();
  }
}

final billingControllerProvider =
    StateNotifierProvider.autoDispose<BillingController, BillingState>((ref) => BillingController(ref));
