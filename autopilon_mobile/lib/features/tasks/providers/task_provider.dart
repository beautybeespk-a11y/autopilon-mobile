import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/task_models.dart';
import '../data/task_repository.dart';

final taskRepositoryProvider = Provider<TaskRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return TaskRepository(apiClientAsync.requireValue);
});

class TasksState {
  final List<Task> tasks;
  final bool loading;
  const TasksState({this.tasks = const [], this.loading = true});
  TasksState copyWith({List<Task>? tasks, bool? loading}) =>
      TasksState(tasks: tasks ?? this.tasks, loading: loading ?? this.loading);
}

class TasksController extends StateNotifier<TasksState> {
  TasksController(this._ref) : super(const TasksState()) {
    load();
  }
  final Ref _ref;

  Future<void> load() async {
    final repo = _ref.read(taskRepositoryProvider);
    final result = await repo.list();
    state = TasksState(tasks: result.data ?? [], loading: false);
  }

  Future<void> add(String title) async {
    if (title.trim().isEmpty) return;
    final repo = _ref.read(taskRepositoryProvider);
    await repo.add(title.trim());
    await load();
  }
}

final tasksControllerProvider =
    StateNotifierProvider.autoDispose<TasksController, TasksState>((ref) => TasksController(ref));

/// Comment thread state per task, loaded on demand when a task is expanded.
class TaskCommentsController extends StateNotifier<AsyncValue<List<TaskComment>>> {
  TaskCommentsController(this._ref, this.taskId) : super(const AsyncValue.loading()) {
    load();
  }
  final Ref _ref;
  final String taskId;

  Future<void> load() async {
    final repo = _ref.read(taskRepositoryProvider);
    final result = await repo.comments(taskId);
    state = AsyncValue.data(result.data ?? []);
  }

  Future<void> send(String content) async {
    if (content.trim().isEmpty) return;
    final repo = _ref.read(taskRepositoryProvider);
    await repo.addComment(taskId, content.trim());
    await load();
  }
}

final taskCommentsControllerProvider = StateNotifierProvider.autoDispose
    .family<TaskCommentsController, AsyncValue<List<TaskComment>>, String>(
        (ref, taskId) => TaskCommentsController(ref, taskId));
