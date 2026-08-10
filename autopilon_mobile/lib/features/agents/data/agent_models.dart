class Agent {
  final String id;
  final String name;
  final String? description;
  final String? personality;
  final String status; // "active" | "inactive"
  final int version;
  final String scope; // "personal" | "organization" | "workspace"
  final bool isOwner;

  Agent({
    required this.id,
    required this.name,
    this.description,
    this.personality,
    required this.status,
    required this.version,
    required this.scope,
    required this.isOwner,
  });

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        description: json['description'],
        personality: json['personality'],
        status: json['status'] ?? 'active',
        version: json['version'] ?? 1,
        scope: json['scope'] ?? 'personal',
        isOwner: json['isOwner'] ?? true,
      );
}

/// GET /agents/:id — the full editable record, including skills and
/// sharing fields the list view (Agent above) doesn't need.
class AgentDetail {
  final String id;
  final String name;
  final String? description;
  final String personality;
  final String? instructions;
  final String? aiProvider;
  final String? aiModel;
  final String? orgId;
  final String? workspaceId;
  final List<String> skillIds;
  final bool canManage;

  AgentDetail({
    required this.id,
    required this.name,
    this.description,
    required this.personality,
    this.instructions,
    this.aiProvider,
    this.aiModel,
    this.orgId,
    this.workspaceId,
    required this.skillIds,
    required this.canManage,
  });

  factory AgentDetail.fromJson(Map<String, dynamic> json) => AgentDetail(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
        description: json['description'],
        personality: json['personality'] ?? 'professional',
        instructions: json['instructions'],
        aiProvider: json['aiProvider'],
        aiModel: json['aiModel'],
        orgId: json['orgId']?.toString(),
        workspaceId: json['workspaceId']?.toString(),
        skillIds: (json['skills'] as List? ?? []).map((s) => (s as Map<String, dynamic>)['id'].toString()).toList(),
        canManage: json['canManage'] ?? true,
      );
}

class AiProviderOption {
  final String id;
  final String label;
  final bool configured;
  AiProviderOption({required this.id, required this.label, required this.configured});
  factory AiProviderOption.fromJson(Map<String, dynamic> json) => AiProviderOption(
        id: json['id']?.toString() ?? '',
        label: json['label'] ?? '',
        configured: json['configured'] == true,
      );
}

class Workspace {
  final String id;
  final String name;
  Workspace({required this.id, required this.name});
  factory Workspace.fromJson(Map<String, dynamic> json) => Workspace(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
      );
}
