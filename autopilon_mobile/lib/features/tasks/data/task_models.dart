class Task {
  final String id;
  final String title;
  final String status;
  final String? priority; // "high" | "medium" | "low" | null

  Task({required this.id, required this.title, required this.status, this.priority});

  factory Task.fromJson(Map<String, dynamic> json) => Task(
        id: json['id']?.toString() ?? '',
        title: json['title'] ?? '',
        status: json['status'] ?? '',
        priority: json['priority'],
      );
}

class TaskComment {
  final String id;
  final String authorName;
  final String content;
  final DateTime createdAt;

  TaskComment({
    required this.id,
    required this.authorName,
    required this.content,
    required this.createdAt,
  });

  factory TaskComment.fromJson(Map<String, dynamic> json) => TaskComment(
        id: json['id']?.toString() ?? '',
        authorName: json['authorName'] ?? 'Unknown',
        content: json['content'] ?? '',
        createdAt: DateTime.tryParse(json['createdAt'] ?? '') ?? DateTime.now(),
      );
}
