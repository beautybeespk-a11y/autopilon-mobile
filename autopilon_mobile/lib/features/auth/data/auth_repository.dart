import '../../../core/api/api_client.dart';
import '../../../core/models/models.dart';

/// Every method here maps 1:1 to an existing backend route
/// (server/routes/auth.js) — no validation or business logic is
/// reimplemented client-side beyond what's needed for a responsive form
/// (e.g. "passwords match"). The server remains the source of truth.
class AuthRepository {
  AuthRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<AppUser>> login(String email, String password) => _api.post<AppUser>(
        '/auth/login',
        body: {'email': email, 'password': password},
        parse: (data) => AppUser.fromJson(data['user']),
      );

  Future<ApiResult<AppUser>> signup(String name, String email, String password) => _api.post<AppUser>(
        '/auth/signup',
        body: {'name': name, 'email': email, 'password': password},
        parse: (data) => AppUser.fromJson(data['user']),
      );

  Future<ApiResult<String>> forgotPassword(String email) => _api.post<String>(
        '/auth/forgot-password',
        body: {'email': email},
        parse: (data) => data['message'] as String,
      );

  Future<ApiResult<AppUser>> me() => _api.get<AppUser>(
        '/auth/me',
        parse: (data) => AppUser.fromJson(data['user']),
      );

  Future<void> logout() async {
    await _api.post('/auth/logout');
    await _api.clearSession();
  }
}
