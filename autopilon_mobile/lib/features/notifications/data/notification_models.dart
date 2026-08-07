class AppNotification {
  final String id;
  final String title;
  final String? body;
  final bool read;
  final String? link;
  final DateTime createdAt;

  AppNotification({
    required this.id,
    required this.title,
    this.body,
    required this.read,
    this.link,
    required this.createdAt,
  });

  factory AppNotification.fromJson(Map<String, dynamic> json) => AppNotification(
        id: json['id']?.toString() ?? '',
        title: json['title'] ?? '',
        body: json['body'],
        read: json['read'] ?? false,
        link: json['link'],
        createdAt: DateTime.tryParse(json['createdAt'] ?? '') ?? DateTime.now(),
      );
}

String timeAgo(DateTime dt) {
  final diff = DateTime.now().difference(dt);
  final mins = diff.inMinutes;
  if (mins < 1) return 'just now';
  if (mins < 60) return '${mins}m ago';
  final hrs = diff.inHours;
  if (hrs < 24) return '${hrs}h ago';
  return '${diff.inDays}d ago';
}
