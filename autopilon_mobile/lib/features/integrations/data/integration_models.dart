/// Mirrors the shape server/routes/integrations.js's CATALOG returns —
/// same fields the web client's Integrations.jsx consumes, just parsed into
/// a real Dart type instead of consumed as raw JSON.
class IntegrationItem {
  final String provider;
  final String name;
  final String? note;
  final bool available;
  final String? connectType; // 'redirect' | 'manual' | null (not connectable, e.g. "Coming soon")
  final String? connectPath; // only set when connectType == 'redirect'
  final String status; // 'connected' | 'not_connected'
  final bool sharedFromOrg;
  final String? setupRequired; // non-null = app owner hasn't finished env-var setup for this provider
  final String? phoneNumber; // WhatsApp only, shown once connected

  const IntegrationItem({
    required this.provider,
    required this.name,
    this.note,
    required this.available,
    this.connectType,
    this.connectPath,
    required this.status,
    this.sharedFromOrg = false,
    this.setupRequired,
    this.phoneNumber,
  });

  bool get connected => status == 'connected';

  factory IntegrationItem.fromJson(Map<String, dynamic> json) => IntegrationItem(
        provider: json['provider'] as String,
        name: json['name'] as String,
        note: json['note'] as String?,
        available: json['available'] as bool? ?? false,
        connectType: json['connectType'] as String?,
        connectPath: json['connectPath'] as String?,
        status: json['status'] as String? ?? 'not_connected',
        sharedFromOrg: json['sharedFromOrg'] as bool? ?? false,
        setupRequired: json['setupRequired'] as String?,
        phoneNumber: json['phoneNumber'] as String?,
      );
}

/// One field in a manual (non-OAuth) connect form — mirrors
/// client/src/pages/Integrations.jsx's MANUAL_FIELDS table exactly, so the
/// two clients ask users for the same information in the same order.
class ManualField {
  final String key;
  final String label;
  final bool obscure;
  final String? placeholder;
  final bool required;

  const ManualField({
    required this.key,
    required this.label,
    this.obscure = false,
    this.placeholder,
    this.required = false,
  });
}

const Map<String, List<ManualField>> kManualIntegrationFields = {
  'whatsapp': [
    ManualField(key: 'accessToken', label: 'Access token', obscure: true, placeholder: 'System User token', required: true),
    ManualField(key: 'phoneNumberId', label: 'Phone number ID', placeholder: 'From Meta dashboard', required: true),
    ManualField(key: 'wabaId', label: 'WhatsApp Business Account ID', placeholder: 'Optional'),
    ManualField(key: 'businessName', label: 'Business name', placeholder: 'Optional'),
  ],
  'wordpress': [
    ManualField(key: 'siteUrl', label: 'Site URL', placeholder: 'https://yourstore.com', required: true),
    ManualField(key: 'username', label: 'Username', required: true),
    ManualField(key: 'appPassword', label: 'Application password', obscure: true, placeholder: 'WP Admin → Users → Application Passwords', required: true),
  ],
  'woocommerce': [
    ManualField(key: 'siteUrl', label: 'Site URL', placeholder: 'https://yourstore.com', required: true),
    ManualField(key: 'consumerKey', label: 'Consumer key', placeholder: 'WooCommerce → Settings → Advanced → REST API', required: true),
    ManualField(key: 'consumerSecret', label: 'Consumer secret', obscure: true, required: true),
  ],
  'shopify': [
    ManualField(key: 'shopDomain', label: 'Shop domain', placeholder: 'yourstore.myshopify.com', required: true),
    ManualField(key: 'accessToken', label: 'Admin API access token', obscure: true, placeholder: 'Shopify Admin → Settings → Apps and sales channels → Develop apps', required: true),
  ],
};
