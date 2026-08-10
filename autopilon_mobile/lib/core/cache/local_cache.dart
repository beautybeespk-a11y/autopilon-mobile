import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

/// A small "last known good" cache for screen data — not a general offline
/// queue or sync engine, just enough that a screen has something to show
/// (with a "showing saved data" note) when a load fails while offline,
/// instead of a blank error screen. Each entry is a JSON blob plus the
/// timestamp it was saved, keyed by an arbitrary string the caller picks
/// (e.g. "dashboard", scoped by org id if the data is org-specific).
class LocalCache {
  static const _prefix = 'cache_';

  static Future<void> save(String key, Map<String, dynamic> data) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('$_prefix$key', jsonEncode({'data': data, 'savedAt': DateTime.now().toIso8601String()}));
  }

  /// Returns null if nothing was ever cached for this key.
  static Future<(Map<String, dynamic> data, DateTime savedAt)?> load(String key) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('$_prefix$key');
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return (
        (decoded['data'] as Map).cast<String, dynamic>(),
        DateTime.tryParse(decoded['savedAt'] ?? '') ?? DateTime.now(),
      );
    } catch (_) {
      return null; // corrupt/old-shape entry — treat as no cache rather than crash
    }
  }
}
