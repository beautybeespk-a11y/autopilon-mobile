class BillingPlan {
  final String id;
  final String name;
  final int monthlyPriceCents;
  final int? maxUsers;
  final int? maxAgents;
  final int? maxAutomations;
  final int? maxIntegrations;
  final int? maxAiRequests;
  final bool marketplaceAccess;
  final String? stripePriceId;

  BillingPlan({
    required this.id,
    required this.name,
    required this.monthlyPriceCents,
    this.maxUsers,
    this.maxAgents,
    this.maxAutomations,
    this.maxIntegrations,
    this.maxAiRequests,
    required this.marketplaceAccess,
    this.stripePriceId,
  });

  /// Direct Stripe checkout requires a Stripe price — Free/Enterprise plans
  /// (no stripePriceId) aren't checkout-able the same way the web client
  /// treats them (contact-us / automatic, not a self-serve upgrade button).
  bool get isCheckoutable => stripePriceId != null;

  factory BillingPlan.fromJson(Map<String, dynamic> json) => BillingPlan(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        monthlyPriceCents: json['monthlyPriceCents'] ?? 0,
        maxUsers: json['maxUsers'],
        maxAgents: json['maxAgents'],
        maxAutomations: json['maxAutomations'],
        maxIntegrations: json['maxIntegrations'],
        maxAiRequests: json['maxAiRequests'],
        marketplaceAccess: json['marketplaceAccess'] == 1 || json['marketplaceAccess'] == true,
        stripePriceId: json['stripePriceId'],
      );
}

class BillingQuota {
  final String type; // maxUsers | maxAgents | maxAutomations | maxIntegrations | maxAiRequests
  final bool allowed;
  final int? limit; // null = unlimited
  final int current;
  final int? remaining;
  final int percentUsed;
  final int? warningLevel;
  final bool isSoft;

  BillingQuota({
    required this.type,
    required this.allowed,
    this.limit,
    required this.current,
    this.remaining,
    required this.percentUsed,
    this.warningLevel,
    required this.isSoft,
  });

  factory BillingQuota.fromJson(Map<String, dynamic> json) => BillingQuota(
        type: json['type'] ?? '',
        allowed: json['allowed'] == true,
        limit: json['limit'],
        current: json['current'] ?? 0,
        remaining: json['remaining'],
        percentUsed: json['percentUsed'] ?? 0,
        warningLevel: json['warningLevel'],
        isSoft: json['isSoft'] == true,
      );
}

class Subscription {
  final String planId;
  final String status; // trialing | active | past_due | canceled
  final String billingMode; // platform_managed | byok
  final String? trialEndsAt;
  final String currentPeriodEnd;
  final bool cancelAtPeriodEnd;
  final BillingPlan? plan;

  Subscription({
    required this.planId,
    required this.status,
    required this.billingMode,
    this.trialEndsAt,
    required this.currentPeriodEnd,
    required this.cancelAtPeriodEnd,
    this.plan,
  });

  factory Subscription.fromJson(Map<String, dynamic> json) => Subscription(
        planId: json['planId']?.toString() ?? '',
        status: json['status'] ?? 'active',
        billingMode: json['billingMode'] ?? 'platform_managed',
        trialEndsAt: json['trialEndsAt'],
        currentPeriodEnd: json['currentPeriodEnd'] ?? '',
        cancelAtPeriodEnd: json['cancelAtPeriodEnd'] == 1 || json['cancelAtPeriodEnd'] == true,
        plan: json['plan'] != null ? BillingPlan.fromJson(json['plan'] as Map<String, dynamic>) : null,
      );
}

class BillingDashboard {
  final Subscription? subscription;
  final List<BillingQuota> quotas;

  BillingDashboard({this.subscription, required this.quotas});

  factory BillingDashboard.fromJson(Map<String, dynamic> json) => BillingDashboard(
        subscription: json['subscription'] != null ? Subscription.fromJson(json['subscription'] as Map<String, dynamic>) : null,
        quotas: (json['quotas'] as List? ?? []).map((q) => BillingQuota.fromJson(q as Map<String, dynamic>)).toList(),
      );
}

class CreditHistoryItem {
  final String id;
  final int amountCents;
  final String? reason;
  final String? grantedByName;
  final String createdAt;

  CreditHistoryItem({required this.id, required this.amountCents, this.reason, this.grantedByName, required this.createdAt});

  factory CreditHistoryItem.fromJson(Map<String, dynamic> json) => CreditHistoryItem(
        id: json['id']?.toString() ?? '',
        amountCents: json['amountCents'] ?? 0,
        reason: json['reason'],
        grantedByName: json['grantedByName'],
        createdAt: json['createdAt'] ?? '',
      );
}

class CreditInfo {
  final int balanceCents;
  final List<CreditHistoryItem> history;
  CreditInfo({required this.balanceCents, required this.history});
  factory CreditInfo.fromJson(Map<String, dynamic> json) => CreditInfo(
        balanceCents: json['balanceCents'] ?? 0,
        history: (json['history'] as List? ?? []).map((h) => CreditHistoryItem.fromJson(h as Map<String, dynamic>)).toList(),
      );
}

class BillingApiKey {
  final String id;
  final String provider;
  final String masked;
  BillingApiKey({required this.id, required this.provider, required this.masked});
  factory BillingApiKey.fromJson(Map<String, dynamic> json) => BillingApiKey(
        id: json['id']?.toString() ?? '',
        provider: json['provider'] ?? '',
        masked: json['masked'] ?? '',
      );
}
