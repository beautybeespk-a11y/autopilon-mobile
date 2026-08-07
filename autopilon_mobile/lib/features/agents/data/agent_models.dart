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
