/// Field definitions for each manual-connect (non-OAuth) integration —
/// mirrors client/src/pages/Integrations.jsx's MANUAL_FIELDS exactly, so the
/// mobile form asks for the same values the web form does. None of these
/// are Meta App ID/Secret: WhatsApp's "Access token" is a per-user System
/// User token from the *user's own* WhatsApp Business setup, not the
/// platform's Meta App credentials.
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

const Map<String, List<ManualField>> manualConnectFields = {
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
