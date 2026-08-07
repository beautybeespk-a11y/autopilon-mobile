import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/notification_models.dart';
import '../data/notification_repository.dart';

final notificationRepositoryProvider = Provider<NotificationRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return NotificationRepository(apiClientAsync.requireValue);
});

class NotificationsState {
  final List<AppNotification> notifications;
  final int unreadCount;
  final bool loading;
  const NotificationsState({this.notifications = const [], this.unreadCount = 0, this.loading = true});
  NotificationsState copyWith({List<AppNotification>? notifications, int? unreadCount, bool? loading}) =>
      NotificationsState(
        notifications: notifications ?? this.notifications,
        unreadCount: unreadCount ?? this.unreadCount,
        loading: loading ?? this.loading,
      );
}

/// Polls every 30s, same as the web client's NotificationBell (no websockets yet).
class NotificationsController extends StateNotifier<NotificationsState> {
  NotificationsController(this._ref) : super(const NotificationsState()) {
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _load());
  }
  final Ref _ref;
  Timer? _timer;

  Future<void> _load() async {
    final repo = _ref.read(notificationRepositoryProvider);
    final result = await repo.list();
    if (result.isSuccess && result.data != null) {
      state = state.copyWith(
        notifications: result.data!.notifications,
        unreadCount: result.data!.unreadCount,
        loading: false,
      );
    } else {
      state = state.copyWith(loading: false);
    }
  }

  Future<void> refresh() => _load();

  Future<void> openNotification(AppNotification n) async {
    if (!n.read) {
      final repo = _ref.read(notificationRepositoryProvider);
      await repo.markRead(n.id);
      await _load();
    }
  }

  Future<void> markAllRead() async {
    final repo = _ref.read(notificationRepositoryProvider);
    await repo.markAllRead();
    await _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

final notificationsControllerProvider =
    StateNotifierProvider<NotificationsController, NotificationsState>((ref) => NotificationsController(ref));
