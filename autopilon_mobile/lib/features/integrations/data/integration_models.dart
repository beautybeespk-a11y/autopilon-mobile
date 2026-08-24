/// Mirrors the shape returned by GET /api/integrations (server/routes/
/// integrations.js CATALOG) — one entry per provider the platform supports,
/// merged with that user's real per-provider connection status.
class IntegrationItem {
  final String provider;
  final String name;
  final String? note;
  final bool available;
  final String connectType; // "redirect" (OAuth) | "manual" | absent for unavailable providers
  final String? connectPath; // relative to the API host root, e.g. /api/integrations/meta/connect
  final String status; // "connected" | "not_connected"
  final bool sharedFromOrg;
  final String? setupRequired; // non-null => platform owner hasn't finished server-side setup
  final String? phoneNumber;

  const IntegrationItem({
    required this.provider,
    required this.name,
    this.note,
    required this.available,
    required this.connectType,
    this.connectPath,
    required this.status,
    required this.sharedFromOrg,
    this.setupRequired,
    this.phoneNumber,
  });

  bool get connected => status == 'connected';

  factory IntegrationItem.fromJson(Map<String, dynamic> json) => IntegrationItem(
        provider: json['provider'] as String,
        name: json['name'] as String,
        note: json['note'] as String?,
        available: json['available'] as bool? ?? false,
        connectType: json['connectType'] as String? ?? '',
        connectPath: json['connectPath'] as String?,
        status: json['status'] as String? ?? 'not_connected',
        sharedFromOrg: json['sharedFromOrg'] as bool? ?? false,
        setupRequired: json['setupRequired'] as String?,
        phoneNumber: json['phoneNumber'] as String?,
      );
}
