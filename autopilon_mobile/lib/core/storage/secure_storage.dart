import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Wraps flutter_secure_storage (Keychain on iOS, Keystore-backed
/// EncryptedSharedPreferences on Android) for the few pieces of session
/// state that aren't the cookie jar itself: whether "remember me" was
/// checked, the last base URL used, the active organization id (purely
/// a client-side convenience cache — the server's own session already
/// knows which org is active; this just avoids an extra round-trip to
/// paint the right org before the first API call resolves), and the
/// manually-chosen theme mode from Settings > Appearance.
class SecureStorage {
  static const _storage = FlutterSecureStorage();

  static const _keyRememberMe = 'remember_me';
  static const _keyBaseUrl = 'base_url';
  static const _keyActiveOrgId = 'active_org_id';
  static const _keyThemeMode = 'theme_mode';

  static Future<void> setRememberMe(bool value) => _storage.write(key: _keyRememberMe, value: value.toString());
  static Future<bool> getRememberMe() async => (await _storage.read(key: _keyRememberMe)) == 'true';

  static Future<void> setBaseUrl(String url) => _storage.write(key: _keyBaseUrl, value: url);
  static Future<String?> getBaseUrl() => _storage.read(key: _keyBaseUrl);

  static Future<void> setActiveOrgId(String? orgId) =>
      orgId == null ? _storage.delete(key: _keyActiveOrgId) : _storage.write(key: _keyActiveOrgId, value: orgId);
  static Future<String?> getActiveOrgId() => _storage.read(key: _keyActiveOrgId);

  /// "light" | "dark" | null (null = follow system, the default).
  static Future<void> setThemeMode(String mode) => _storage.write(key: _keyThemeMode, value: mode);
  static Future<String?> getThemeMode() => _storage.read(key: _keyThemeMode);

  static Future<void> clearAll() => _storage.deleteAll();
}
