import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/notification_models.dart';
import '../providers/notification_provider.dart';

/// Mobile equivalent of the web client's NotificationBell dropdown.
/// A dropdown doesn't translate well to mobile, so this opens a bottom sheet
/// with the same content: mark-all-read, list, empty state, tap-to-open.
class NotificationBellButton extends ConsumerWidget {
  const NotificationBellButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(notificationsControllerProvider);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        IconButton(
          icon: const Icon(Icons.notifications_outlined),
          onPressed: () => _openSheet(context, ref),
        ),
        if (state.unreadCount > 0)
          Positioned(
            right: 6,
            top: 6,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              constraints: const BoxConstraints(minWidth: 16),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primary,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                state.unreadCount > 9 ? '9+' : '${state.unreadCount}',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 10, color: Colors.white, fontWeight: FontWeight.bold),
              ),
            ),
          ),
      ],
    );
  }

  void _openSheet(BuildContext context, WidgetRef ref) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => const _NotificationSheet(),
    );
  }
}

class _NotificationSheet extends ConsumerWidget {
  const _NotificationSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(notificationsControllerProvider);
    final controller = ref.read(notificationsControllerProvider.notifier);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Notifications', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  if (state.unreadCount > 0)
                    TextButton(
                      onPressed: controller.markAllRead,
                      child: const Text('Mark all read'),
                    ),
                ],
              ),
            ),
            const Divider(height: 16),
            SizedBox(
              height: MediaQuery.of(context).size.height * 0.5,
              child: state.notifications.isEmpty
                  ? const Center(
                      child: Text('No notifications yet.', style: TextStyle(color: Colors.grey)),
                    )
                  : ListView.builder(
                      itemCount: state.notifications.length,
                      itemBuilder: (context, i) {
                        final n = state.notifications[i];
                        return ListTile(
                          tileColor: n.read ? null : Theme.of(context).colorScheme.primary.withOpacity(0.05),
                          title: Row(
                            children: [
                              Expanded(child: Text(n.title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                              if (!n.read)
                                Container(
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    color: Theme.of(context).colorScheme.primary,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                            ],
                          ),
                          subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (n.body?.isNotEmpty == true)
                                Text(n.body!, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
                              Text(timeAgo(n.createdAt), style: const TextStyle(fontSize: 10, color: Colors.grey)),
                            ],
                          ),
                          onTap: () {
                            controller.openNotification(n);
                            Navigator.pop(context);
                            // Note: n.link points to a web-client route (e.g. /app/...).
                            // In-app deep-link routing for notification links is not
                            // wired up yet — scope for a later batch.
                          },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
