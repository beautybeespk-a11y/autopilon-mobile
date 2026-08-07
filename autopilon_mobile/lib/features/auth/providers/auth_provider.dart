import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_client.dart';
import '../../../core/storage/secure_storage.dart';
import '../../../core/models/models.dart';
import '../data/auth_repository.dart';

/// The single source of truth for "is anyone logged in, and who" — the
/// router's redirect logic (core/router/app_router.dart) watches this
/// directly, so login/logout immediately reroutes the whole app.
final apiClientProvider = FutureProvider<ApiClient>((ref) => ApiClient.create());

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return AuthRepository(apiClientAsync.requireValue);
});

enum AuthStatus { unknown, authenticated, unauthenticated }

class AuthState {
  final AuthStatus status;
  final AppUser? user;
  final String? error;
  const AuthState({this.status = AuthStatus.unknown, this.user, this.error});

  AuthState copyWith({AuthStatus? status, AppUser? user, String? error}) =>
      AuthState(status: status ?? this.status, user: user ?? this.user, error: error);
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState()) {
    _restoreSession();
  }
  final Ref _ref;

  /// On app start, try the existing session cookie (if any) against
  /// GET /auth/me — this is what makes "remember me" actually work: if the
  /// cookie jar still has a valid session, the user never sees the login
  /// screen at all.
  Future<void> _restoreSession() async {
    final apiClientAsync = await _ref.read(apiClientProvider.future);
    final repo = AuthRepository(apiClientAsync);
    final result = await repo.me();
    if (result.isSuccess) {
      state = AuthState(status: AuthStatus.authenticated, user: result.data);
    } else {
      state = const AuthState(status: AuthStatus.unauthenticated);
    }
  }

  Future<bool> login(String email, String password, {required bool rememberMe}) async {
    final repo = _ref.read(authRepositoryProvider);
    final result = await repo.login(email, password);
    if (result.isSuccess) {
      await SecureStorage.setRememberMe(rememberMe);
      state = AuthState(status: AuthStatus.authenticated, user: result.data);
      return true;
    }
    state = AuthState(status: AuthStatus.unauthenticated, error: result.error);
    return false;
  }

  Future<bool> signup(String name, String email, String password) async {
    final repo = _ref.read(authRepositoryProvider);
    final result = await repo.signup(name, email, password);
    if (result.isSuccess) {
      state = AuthState(status: AuthStatus.authenticated, user: result.data);
      return true;
    }
    state = AuthState(status: AuthStatus.unauthenticated, error: result.error);
    return false;
  }

  Future<void> logout() async {
    final repo = _ref.read(authRepositoryProvider);
    await repo.logout();
    await SecureStorage.clearAll();
    state = const AuthState(status: AuthStatus.unauthenticated);
  }
}

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));
