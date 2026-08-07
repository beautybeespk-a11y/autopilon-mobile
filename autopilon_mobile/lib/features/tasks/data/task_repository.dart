import '../../../core/api/api_client.dart';
import 'task_models.dart';

class TaskRepository {
  TaskRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<Task>>> list() => _api.get<List<Task>>(
        '/tasks',
        parse: (data) => (data as List).map((t) => Task.fromJson(t)).toList(),
      );

  Future<ApiResult<void>> add(String title) => _api.post<void>(
        '/tasks',
        body: {'title': title},
        parse: (_) {},
      );

  Future<ApiResult<List<TaskComment>>> comments(String taskId) => _api.get<List<TaskComment>>(
        '/entities/task/$taskId/comments',
        parse: (data) => (data as List).map((c) => TaskComment.fromJson(c)).toList(),
      );

  Future<ApiResult<void>> addComment(String taskId, String content) => _api.post<void>(
        '/entities/task/$taskId/comments',
        body: {'content': content},
        parse: (_) {},
      );
}
