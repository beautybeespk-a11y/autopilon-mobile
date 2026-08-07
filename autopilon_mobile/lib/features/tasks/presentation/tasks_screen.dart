import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/task_models.dart';
import '../providers/task_provider.dart';

const _priorityColor = {
  'high': Colors.orange,
  'medium': Colors.blue,
  'low': Colors.grey,
};

class TasksScreen extends ConsumerStatefulWidget {
  const TasksScreen({super.key});
  @override
  ConsumerState<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends ConsumerState<TasksScreen> {
  final _titleCtrl = TextEditingController();
  String? _openTaskId;

  @override
  void dispose() {
    _titleCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(tasksControllerProvider);
    final controller = ref.read(tasksControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Tasks')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _titleCtrl,
                    decoration: const InputDecoration(hintText: 'Add a task…', isDense: true),
                    onSubmitted: (v) {
                      controller.add(v);
                      _titleCtrl.clear();
                    },
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: () {
                    controller.add(_titleCtrl.text);
                    _titleCtrl.clear();
                  },
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Add'),
                ),
              ],
            ),
          ),
          Expanded(
            child: state.loading
                ? const Center(child: CircularProgressIndicator())
                : state.tasks.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.checklist_outlined, size: 48, color: Colors.grey),
                              SizedBox(height: 8),
                              Text('No tasks yet', style: TextStyle(fontWeight: FontWeight.bold)),
                              Text('Add your first task above.', style: TextStyle(color: Colors.grey)),
                            ],
                          ),
                        ),
                      )
                    : RefreshIndicator(
                        onRefresh: controller.load,
                        child: ListView.separated(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          itemCount: state.tasks.length,
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemBuilder: (context, i) {
                            final t = state.tasks[i];
                            final open = _openTaskId == t.id;
                            return Column(
                              children: [
                                ListTile(
                                  title: Text(t.title),
                                  subtitle: Row(
                                    children: [
                                      if (t.priority != null) _badge(t.priority!, _priorityColor[t.priority] ?? Colors.grey),
                                      const SizedBox(width: 6),
                                      _badge(t.status, Colors.grey),
                                    ],
                                  ),
                                  trailing: IconButton(
                                    icon: const Icon(Icons.chat_bubble_outline, size: 18),
                                    tooltip: 'Comments',
                                    onPressed: () => setState(() => _openTaskId = open ? null : t.id),
                                  ),
                                ),
                                if (open) _CommentThread(taskId: t.id),
                              ],
                            );
                          },
                        ),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _badge(String label, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(20)),
        child: Text(label, style: TextStyle(fontSize: 11, color: color)),
      );
}

class _CommentThread extends ConsumerStatefulWidget {
  const _CommentThread({required this.taskId});
  final String taskId;
  @override
  ConsumerState<_CommentThread> createState() => _CommentThreadState();
}

class _CommentThreadState extends ConsumerState<_CommentThread> {
  final _textCtrl = TextEditingController();

  @override
  void dispose() {
    _textCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final commentsAsync = ref.watch(taskCommentsControllerProvider(widget.taskId));
    final controller = ref.read(taskCommentsControllerProvider(widget.taskId).notifier);

    return Container(
      color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.3),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          commentsAsync.when(
            data: (comments) => comments.isEmpty
                ? const Text('No comments yet.', style: TextStyle(fontSize: 12, color: Colors.grey))
                : Column(
                    children: comments
                        .map((c) => Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Text(c.authorName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
                                      const SizedBox(width: 6),
                                      Text(c.createdAt.toLocal().toString().split('.').first,
                                          style: const TextStyle(fontSize: 10, color: Colors.grey)),
                                    ],
                                  ),
                                  Text(c.content, style: const TextStyle(fontSize: 13)),
                                ],
                              ),
                            ))
                        .toList(),
                  ),
            loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
            error: (e, _) => Text('Could not load comments.', style: TextStyle(color: Colors.red[300])),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _textCtrl,
                  decoration: const InputDecoration(hintText: 'Add a comment — use @name to mention a teammate', isDense: true),
                  onSubmitted: (v) {
                    controller.send(v);
                    _textCtrl.clear();
                  },
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () {
                  controller.send(_textCtrl.text);
                  _textCtrl.clear();
                },
                child: const Text('Send'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
