class ContentAsset {
  final String id;
  final String contentType;
  final String title;
  final String? fileId;
  final String? textContent;
  final String status;
  final String? errorMessage;
  final int currentVersion;
  final bool favorite;
  final String updatedAt;

  ContentAsset({
    required this.id,
    required this.contentType,
    required this.title,
    this.fileId,
    this.textContent,
    required this.status,
    this.errorMessage,
    required this.currentVersion,
    required this.favorite,
    required this.updatedAt,
  });

  factory ContentAsset.fromJson(Map<String, dynamic> json) => ContentAsset(
        id: json['id']?.toString() ?? '',
        contentType: json['contentType'] ?? '',
        title: json['title'] ?? 'Untitled',
        fileId: json['fileId'],
        textContent: json['textContent'],
        status: json['status'] ?? 'ready',
        errorMessage: json['errorMessage'],
        currentVersion: (json['currentVersion'] as num?)?.toInt() ?? 1,
        favorite: json['favorite'] == true || json['favorite'] == 1,
        updatedAt: json['updatedAt'] ?? '',
      );
}

class CopyType {
  final String id;
  final String label;
  CopyType({required this.id, required this.label});
  factory CopyType.fromJson(Map<String, dynamic> json) => CopyType(id: json['id'] ?? '', label: json['label'] ?? '');
}

/// Only the "is a provider configured" bit mobile actually needs to show a
/// "Provider not configured" notice before the user tries to generate —
/// the full capabilities payload (resolutions, pricing, etc.) is web-only.
class ProviderStatus {
  final bool configured;
  final String? reason;
  ProviderStatus({required this.configured, this.reason});
  factory ProviderStatus.fromJson(Map<String, dynamic> json) =>
      ProviderStatus(configured: json['configured'] == true, reason: json['reason']);
}
