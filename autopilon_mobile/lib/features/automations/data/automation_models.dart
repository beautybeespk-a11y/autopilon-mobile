import 'dart:convert';

class Automation {
  final String id;
  final String name;
  final String? description;
  final String status; // draft | active | paused
  final String triggerType;
  final String? orgId;
  final String? workspaceId;
  final String? lastRunAt;
  final String? nextRunAt;

  Automation({
    required this.id,
    required this.name,
    this.description,
    required this.status,
    required this.triggerType,
    this.orgId,
    this.workspaceId,
    this.lastRunAt,
    this.nextRunAt,
  });

  factory Automation.fromJson(Map<String, dynamic> json) => Automation(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        description: json['description'],
        status: json['status'] ?? 'draft',
        triggerType: json['triggerType'] ?? 'manual',
        orgId: json['orgId']?.toString(),
        workspaceId: json['workspaceId']?.toString(),
        lastRunAt: json['lastRunAt'],
        nextRunAt: json['nextRunAt'],
      );
}

class AutomationStep {
  String type; // action | condition | ai_decision | approval | delay | loop | end
  Map<String, dynamic> config;
  AutomationStep({required this.type, required this.config});

  factory AutomationStep.fromJson(Map<String, dynamic> json) => AutomationStep(
        type: json['type'] ?? 'action',
        config: (json['config'] as Map?)?.cast<String, dynamic>() ?? {},
      );

  Map<String, dynamic> toJson() => {'type': type, 'config': config};
}

class AutomationDetail {
  final String id;
  final String name;
  final String description;
  final String triggerType;
  final Map<String, dynamic> triggerConfig;
  final String agentId;
  final List<AutomationStep> steps;

  AutomationDetail({
    required this.id,
    required this.name,
    required this.description,
    required this.triggerType,
    required this.triggerConfig,
    required this.agentId,
    required this.steps,
  });

  factory AutomationDetail.fromJson(Map<String, dynamic> json) {
    // The server stores/returns triggerConfig as a JSON string on the
    // detail endpoint (unlike the list endpoint) — same quirk the web
    // client's AutomationBuilder.jsx works around with JSON.parse.
    final rawConfig = json['triggerConfig'];
    final config = rawConfig is String
        ? (rawConfig.isEmpty ? <String, dynamic>{} : (jsonDecode(rawConfig) as Map).cast<String, dynamic>())
        : (rawConfig as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    return AutomationDetail(
      id: json['id']?.toString() ?? '',
      name: json['name'] ?? '',
      description: json['description'] ?? '',
      triggerType: json['triggerType'] ?? 'manual',
      triggerConfig: config,
      agentId: json['agentId']?.toString() ?? '',
      steps: (json['steps'] as List? ?? []).map((s) => AutomationStep.fromJson(s as Map<String, dynamic>)).toList(),
    );
  }
}

class AutomationRun {
  final String id;
  final String status; // pending | running | awaiting_approval | completed | failed | cancelled
  final String? triggerSource;
  final String createdAt;

  AutomationRun({required this.id, required this.status, this.triggerSource, required this.createdAt});

  factory AutomationRun.fromJson(Map<String, dynamic> json) => AutomationRun(
        id: json['id']?.toString() ?? '',
        status: json['status'] ?? 'pending',
        triggerSource: json['triggerSource'],
        createdAt: json['createdAt'] ?? '',
      );
}

class AutomationDashboard {
  final int activeWorkflows;
  final int pausedWorkflows;
  final int todaysExecutions;
  final int failedExecutions;
  final num successRate;
  final num avgRuntimeMs;
  final int upcomingSchedules;
  final int runningWorkflows;

  AutomationDashboard({
    required this.activeWorkflows,
    required this.pausedWorkflows,
    required this.todaysExecutions,
    required this.failedExecutions,
    required this.successRate,
    required this.avgRuntimeMs,
    required this.upcomingSchedules,
    required this.runningWorkflows,
  });

  factory AutomationDashboard.fromJson(Map<String, dynamic> json) => AutomationDashboard(
        activeWorkflows: json['activeWorkflows'] ?? 0,
        pausedWorkflows: json['pausedWorkflows'] ?? 0,
        todaysExecutions: json['todaysExecutions'] ?? 0,
        failedExecutions: json['failedExecutions'] ?? 0,
        successRate: json['successRate'] ?? 0,
        avgRuntimeMs: json['avgRuntimeMs'] ?? 0,
        upcomingSchedules: json['upcomingSchedules'] ?? 0,
        runningWorkflows: json['runningWorkflows'] ?? 0,
      );
}
