import '../../../core/api/api_client.dart';
import '../../dashboard/data/dashboard_models.dart' show CostData;
import 'billing_models.dart';

class BillingRepository {
  BillingRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<BillingPlan>>> plans() => _api.get<List<BillingPlan>>(
        '/plans',
        parse: (data) => (data as List).map((p) => BillingPlan.fromJson(p)).toList(),
      );

  Future<ApiResult<BillingDashboard>> billing(String orgId) => _api.get<BillingDashboard>(
        '/organizations/$orgId/billing',
        parse: (data) => BillingDashboard.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<CostData>> cost(String orgId, {int sinceDays = 30}) => _api.get<CostData>(
        '/organizations/$orgId/cost',
        query: {'sinceDays': sinceDays},
        parse: (data) => CostData.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<CreditInfo>> credits(String orgId) => _api.get<CreditInfo>(
        '/organizations/$orgId/credits',
        parse: (data) => CreditInfo.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<List<BillingApiKey>>> apiKeys(String orgId) => _api.get<List<BillingApiKey>>(
        '/organizations/$orgId/api-keys',
        parse: (data) => (data as List).map((k) => BillingApiKey.fromJson(k)).toList(),
      );

  /// Returns the Stripe checkout URL to upgrade/downgrade to a given plan —
  /// same as the web client, plan changes go through real payment, not a
  /// direct assignment (that endpoint is platform-admin only now).
  Future<ApiResult<String?>> checkout(String orgId, String planId) => _api.post<String?>(
        '/organizations/$orgId/billing/checkout',
        body: {'planId': planId},
        parse: (data) => (data as Map<String, dynamic>)['url'] as String?,
      );

  Future<ApiResult<String?>> portal(String orgId) => _api.post<String?>(
        '/organizations/$orgId/billing/portal',
        body: const {},
        parse: (data) => (data as Map<String, dynamic>)['url'] as String?,
      );

  Future<ApiResult<void>> cancelSubscription(String orgId) => _api.post<void>(
        '/organizations/$orgId/billing/cancel',
        body: const {'atPeriodEnd': true},
        parse: (_) {},
      );

  Future<ApiResult<void>> resumeSubscription(String orgId) => _api.post<void>(
        '/organizations/$orgId/billing/resume',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> setBillingMode(String orgId, String mode) => _api.post<void>(
        '/organizations/$orgId/billing/mode',
        body: {'billingMode': mode},
        parse: (_) {},
      );

  Future<ApiResult<void>> addApiKey(String orgId, String provider, String apiKey) => _api.post<void>(
        '/organizations/$orgId/api-keys',
        body: {'provider': provider, 'apiKey': apiKey},
        parse: (_) {},
      );

  Future<ApiResult<void>> removeApiKey(String orgId, String provider) => _api.delete<void>(
        '/organizations/$orgId/api-keys/$provider',
        parse: (_) {},
      );

  Future<ApiResult<void>> redeemCoupon(String orgId, String code) => _api.post<void>(
        '/organizations/$orgId/coupons/redeem',
        body: {'code': code},
        parse: (_) {},
      );
}
