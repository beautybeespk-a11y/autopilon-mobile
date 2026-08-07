import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:path_provider/path_provider.dart';

/// The backend (server/index.js) uses express-session — a session cookie,
/// not a bearer token. Rather than adding a parallel token-auth system to
/// the backend (which would duplicate the existing, working auth logic),
/// this client carries a real persistent cookie jar, the same way a browser
/// does. Login sets the cookie; every subsequent request sends it back
/// automatically via Dio's cookie manager interceptor.
class ApiClient {
  ApiClient._(this._dio, this._cookieJar);

  final Dio _dio;
  final PersistCookieJar _cookieJar;

  /// Set this once at app startup (see main.dart) — the base URL of your
  /// running Autopilon server, e.g. your Codespace's forwarded port-4000 URL.
  static String baseUrl = 'https://isotope-dipping-cobweb.ngrok-free.dev/api';

  static Future<ApiClient> create() async {
    final dir = await getApplicationDocumentsDirectory();
    final cookieJar = PersistCookieJar(storage: FileStorage('${dir.path}/.cookies/'));
    final dio = Dio(BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 20),
      headers: {'Content-Type': 'application/json'},
      validateStatus: (status) => status != null && status < 500, // handle 4xx ourselves, not as Dio exceptions
    ));
    dio.interceptors.add(CookieManager(cookieJar));
    return ApiClient._(dio, cookieJar);
  }

  Future<ApiResult<T>> get<T>(String path, {Map<String, dynamic>? query, T Function(dynamic)? parse}) =>
      _request('GET', path, query: query, parse: parse);

  Future<ApiResult<T>> post<T>(String path, {Object? body, T Function(dynamic)? parse}) =>
      _request('POST', path, body: body, parse: parse);

  Future<ApiResult<T>> patch<T>(String path, {Object? body, T Function(dynamic)? parse}) =>
      _request('PATCH', path, body: body, parse: parse);

  Future<ApiResult<T>> delete<T>(String path, {T Function(dynamic)? parse}) =>
      _request('DELETE', path, parse: parse);

  Future<ApiResult<T>> _request<T>(
    String method,
    String path, {
    Map<String, dynamic>? query,
    Object? body,
    T Function(dynamic)? parse,
  }) async {
    try {
      final res = await _dio.request(
        path,
        data: body,
        queryParameters: query,
        options: Options(method: method),
      );
      if (res.statusCode != null && res.statusCode! >= 200 && res.statusCode! < 300) {
        final data = parse != null ? parse(res.data) : res.data as T;
        return ApiResult.success(data);
      }
      final errorMessage = (res.data is Map && res.data['error'] != null) ? res.data['error'] as String : 'Request failed (${res.statusCode}).';
      return ApiResult.failure(errorMessage, statusCode: res.statusCode);
    } on DioException catch (e) {
      final isTimeout = e.type == DioExceptionType.connectionTimeout || e.type == DioExceptionType.receiveTimeout;
      return ApiResult.failure(
        isTimeout ? "Couldn't reach the server — check your connection and the server URL." : (e.message ?? 'Network error.'),
      );
    }
  }

  /// Wipes the session cookie locally — used on logout. The server-side
  /// session is also destroyed via the normal POST /auth/logout call;
  /// this just clears what the device is holding onto.
  Future<void> clearSession() => _cookieJar.deleteAll();
}

/// A tiny Result type so every screen handles "worked" vs "didn't" the same
/// way, instead of try/catching Dio exceptions all over the UI layer.
class ApiResult<T> {
  final T? data;
  final String? error;
  final int? statusCode;
  final bool isSuccess;

  ApiResult.success(this.data) : error = null, statusCode = null, isSuccess = true;
  ApiResult.failure(this.error, {this.statusCode}) : data = null, isSuccess = false;
}
