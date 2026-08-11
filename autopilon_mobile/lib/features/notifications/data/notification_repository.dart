import '../../../core/api/api_client.dart';
import 'notification_models.dart';

class NotificationRepository {
  NotificationRepository(this._api);
  final ApiClient _api;

  /// Server returns { notifications: [...], unreadCount: N }
  Future<ApiResult<NotificationsPayload>> list() => _api.get<NotificationsPayload>(
        '/notifications',
        parse: (data) => NotificationsPayload.fromJson(data as Map<String, dynamic>),
      );

  Future<ApiResult<void>> markRead(String id) => _api.post<void>(
        '/notifications/$id/read',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> markAllRead() => _api.post<void>(
        '/notifications/read-all',
        body: const {},
        parse: (_) {},
      );

  Future<ApiResult<void>> registerDeviceToken(String token, {String platform = 'android'}) => _api.post<void>(
        '/notifications/device-token',
        body: {'token': token, 'platform': platform},
        parse: (_) {},
      );

  Future<ApiResult<void>> unregisterDeviceToken(String token) => _api.delete<void>(
        '/notifications/device-token/${Uri.encodeComponent(token)}',
        parse: (_) {},
      );
}

class NotificationsPayload {
  final List<AppNotification> notifications;
  final int unreadCount;
  NotificationsPayload({required this.notifications, required this.unreadCount});
  factory NotificationsPayload.fromJson(Map<String, dynamic> json) => NotificationsPayload(
        notifications: (json['notifications'] as List? ?? [])
            .map((n) => AppNotification.fromJson(n as Map<String, dynamic>))
            .toList(),
        unreadCount: json['unreadCount'] ?? 0,
      );
}
