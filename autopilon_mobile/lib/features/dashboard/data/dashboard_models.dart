class DashboardData {
  final MemberStats members;
  final AgentStats agents;
  final AutomationStats automations;
  final int connectedIntegrations;
  final int workspaceCount;
  final List<SecurityAlert> securityAlerts;
  final List<RecentActivity> recentActivity;

  DashboardData({
    required this.members,
    required this.agents,
    required this.automations,
    required this.connectedIntegrations,
    required this.workspaceCount,
    required this.securityAlerts,
    required this.recentActivity,
  });

  factory DashboardData.fromJson(Map<String, dynamic> json) => DashboardData(
        members: MemberStats.fromJson(json['members'] ?? {}),
        agents: AgentStats.fromJson(json['agents'] ?? {}),
        automations: AutomationStats.fromJson(json['automations'] ?? {}),
        connectedIntegrations: json['connectedIntegrations'] ?? 0,
        workspaceCount: json['workspaceCount'] ?? 0,
        securityAlerts: (json['securityAlerts'] as List? ?? [])
            .map((e) => SecurityAlert.fromJson(e as Map<String, dynamic>))
            .toList(),
        recentActivity: (json['recentActivity'] as List? ?? [])
            .map((e) => RecentActivity.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// Round-trips through LocalCache (offline mode) — the shape here must
  /// stay parseable by fromJson above.
  Map<String, dynamic> toJson() => {
        'members': members.toJson(),
        'agents': agents.toJson(),
        'automations': automations.toJson(),
        'connectedIntegrations': connectedIntegrations,
        'workspaceCount': workspaceCount,
        'securityAlerts': securityAlerts.map((s) => s.toJson()).toList(),
        'recentActivity': recentActivity.map((a) => a.toJson()).toList(),
      };
}

class MemberStats {
  final int total;
  final int active;
  final int invited;
  MemberStats({required this.total, required this.active, required this.invited});
  factory MemberStats.fromJson(Map<String, dynamic> json) => MemberStats(
        total: json['total'] ?? 0,
        active: json['active'] ?? 0,
        invited: json['invited'] ?? 0,
      );
  Map<String, dynamic> toJson() => {'total': total, 'active': active, 'invited': invited};
}

class AgentStats {
  final int total;
  final int active;
  AgentStats({required this.total, required this.active});
  factory AgentStats.fromJson(Map<String, dynamic> json) => AgentStats(
        total: json['total'] ?? 0,
        active: json['active'] ?? 0,
      );
  Map<String, dynamic> toJson() => {'total': total, 'active': active};
}

class AutomationStats {
  final int total;
  final int runningNow;
  AutomationStats({required this.total, required this.runningNow});
  factory AutomationStats.fromJson(Map<String, dynamic> json) => AutomationStats(
        total: json['total'] ?? 0,
        runningNow: json['runningNow'] ?? 0,
      );
  Map<String, dynamic> toJson() => {'total': total, 'runningNow': runningNow};
}

class SecurityAlert {
  final String id;
  final String title;
  final String? description;
  SecurityAlert({required this.id, required this.title, this.description});
  factory SecurityAlert.fromJson(Map<String, dynamic> json) => SecurityAlert(
        id: json['id']?.toString() ?? '',
        title: json['title'] ?? json['message'] ?? 'Security alert',
        description: json['description'],
      );
  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'description': description};
}

class RecentActivity {
  final String id;
  final DateTime createdAt;
  final String userName;
  final String action;
  final String result;
  RecentActivity({
    required this.id,
    required this.createdAt,
    required this.userName,
    required this.action,
    required this.result,
  });
  factory RecentActivity.fromJson(Map<String, dynamic> json) => RecentActivity(
        id: json['id']?.toString() ?? '',
        createdAt: DateTime.tryParse(json['createdAt'] ?? '') ?? DateTime.now(),
        userName: json['userName'] ?? 'Unknown',
        action: json['action'] ?? '',
        result: json['result'] ?? 'success',
      );
  Map<String, dynamic> toJson() => {
        'id': id,
        'createdAt': createdAt.toIso8601String(),
        'userName': userName,
        'action': action,
        'result': result,
      };
}

class CostData {
  final int estimatedCostCents;
  final int byokUsageCents;
  final List<ProviderCost> byProvider;
  final List<AgentCost> byAgent;
  CostData({
    required this.estimatedCostCents,
    required this.byokUsageCents,
    required this.byProvider,
    required this.byAgent,
  });
  factory CostData.fromJson(Map<String, dynamic> json) => CostData(
        estimatedCostCents: json['estimatedCostCents'] ?? 0,
        // Server key is byokCostCents (server/orchestrator/costEngine.js) —
        // this used to read a key that doesn't exist, so BYOK cost always
        // showed $0 regardless of actual usage.
        byokUsageCents: json['byokCostCents'] ?? 0,
        byProvider: (json['byProvider'] as List? ?? [])
            .map((e) => ProviderCost.fromJson(e as Map<String, dynamic>))
            .toList(),
        byAgent: (json['byAgent'] as List? ?? [])
            .map((e) => AgentCost.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class ProviderCost {
  final String provider;
  final int cents;
  ProviderCost({required this.provider, required this.cents});
  factory ProviderCost.fromJson(Map<String, dynamic> json) => ProviderCost(
        provider: json['provider'] ?? '',
        cents: json['cents'] ?? 0,
      );
}

class AgentCost {
  final String agentId;
  final String name;
  final int cents;
  AgentCost({required this.agentId, required this.name, required this.cents});
  factory AgentCost.fromJson(Map<String, dynamic> json) => AgentCost(
        agentId: json['agentId']?.toString() ?? '',
        name: json['name'] ?? '',
        cents: json['cents'] ?? 0,
      );
}

class AnalyticsData {
  final List<MostUsedAgent> mostUsedAgents;
  final List<WorkspaceActivity> workspaceActivity;
  AnalyticsData({required this.mostUsedAgents, required this.workspaceActivity});
  factory AnalyticsData.fromJson(Map<String, dynamic> json) => AnalyticsData(
        mostUsedAgents: (json['mostUsedAgents'] as List? ?? [])
            .map((e) => MostUsedAgent.fromJson(e as Map<String, dynamic>))
            .toList(),
        workspaceActivity: (json['workspaceActivity'] as List? ?? [])
            .map((e) => WorkspaceActivity.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class MostUsedAgent {
  final String id;
  final String name;
  final int messageCount;
  MostUsedAgent({required this.id, required this.name, required this.messageCount});
  factory MostUsedAgent.fromJson(Map<String, dynamic> json) => MostUsedAgent(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        messageCount: json['messageCount'] ?? 0,
      );
}

class WorkspaceActivity {
  final String id;
  final String name;
  final int agentCount;
  final int automationCount;
  final int projectCount;
  WorkspaceActivity({
    required this.id,
    required this.name,
    required this.agentCount,
    required this.automationCount,
    required this.projectCount,
  });
  factory WorkspaceActivity.fromJson(Map<String, dynamic> json) => WorkspaceActivity(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        agentCount: json['agentCount'] ?? 0,
        automationCount: json['automationCount'] ?? 0,
        projectCount: json['projectCount'] ?? 0,
      );
}
