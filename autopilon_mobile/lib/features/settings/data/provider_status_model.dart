class ProviderStatus {
  final bool configured;
  final String label;
  final String? reason;

  ProviderStatus({required this.configured, required this.label, this.reason});

  factory ProviderStatus.fromJson(Map<String, dynamic> json) => ProviderStatus(
        configured: json['configured'] == true,
        label: json['label'] ?? '',
        reason: json['reason'] as String?,
      );
}
