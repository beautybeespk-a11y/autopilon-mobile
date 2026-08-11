import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/notifications/providers/notification_provider.dart';
import '../router/app_router.dart';

/// Registers this device for push notifications and wires tapping one to
/// navigate to its `link` — the same field the in-app notification bell
/// already uses, just delivered while the app isn't open. Every step here
/// is wrapped so a device without Google Play Services, a denied
/// permission, or Firebase simply not being reachable just means push
/// silently doesn't work — never a crash, and nothing else in the app
/// depends on it.
class PushService {
  PushService(this._ref);
  final Ref _ref;
  String? _registeredToken;

  Future<void> init() async {
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;

      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _register(token);
      FirebaseMessaging.instance.onTokenRefresh.listen(_register);

      // Android suppresses the system notification banner while the app is
      // in the foreground — without this, a push arriving while the app is
      // open produces literally no visible feedback at all. Refreshing the
      // bell (which also updates its unread badge) is the minimal fix; a
      // proper in-app banner would need flutter_local_notifications, which
      // isn't in scope here.
      FirebaseMessaging.onMessage.listen((_) {
        _ref.read(notificationsControllerProvider.notifier).refresh();
      });

      FirebaseMessaging.onMessageOpenedApp.listen(_handleTap);
      final initialMessage = await FirebaseMessaging.instance.getInitialMessage();
      if (initialMessage != null) _handleTap(initialMessage);
    } catch (_) {
      // Not configured on this device, or Firebase project not reachable —
      // treat identically to "user denied permission."
    }
  }

  Future<void> _register(String token) async {
    _registeredToken = token;
    final repo = _ref.read(notificationRepositoryProvider);
    await repo.registerDeviceToken(token);
  }

  void _handleTap(RemoteMessage message) {
    final link = message.data['link'];
    if (link != null && link.isNotEmpty) {
      _ref.read(routerProvider).go(link);
    }
  }

  /// Called on logout — a push arriving for a device no one is signed into
  /// anymore would be a data leak to whoever picks up the phone next.
  Future<void> unregister() async {
    final token = _registeredToken;
    if (token == null) return;
    final repo = _ref.read(notificationRepositoryProvider);
    await repo.unregisterDeviceToken(token);
    _registeredToken = null;
  }
}

final pushServiceProvider = Provider<PushService>((ref) => PushService(ref));
