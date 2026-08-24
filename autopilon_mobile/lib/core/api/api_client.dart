import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
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
  final _sessionExpiredController = StreamController<void>.broadcast();

  /// Fires when an already-authenticated request comes back 401 — i.e. the
  /// session cookie was valid a moment ago and now isn't (expired, or
  /// revoked server-side). AuthController (features/auth/providers/
  /// auth_provider.dart) listens to this and flips auth state to
  /// unauthenticated, which the router's redirect already sends to /login
  /// (Phase 18 §33 — previously there was no mid-session expiry detection
  /// at all: an expired cookie just meant every subsequent screen quietly
  /// failed its requests with no path back to the login screen).
  Stream<void> get onSessionExpired => _sessionExpiredController.stream;

  /// Set once at app startup from AppConfig.apiBaseUrl (see main.dart and
  /// core/config/app_config.dart) — resolved from --dart-define values,
  /// not hardcoded. The empty-string default here is never actually used
  /// at runtime (main.dart always assigns a real value before create() is
  /// called); it exists only so this field has a valid initial value.
  static String baseUrl = '';

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
    final client = ApiClient._(dio, cookieJar);
    dio.interceptors.add(InterceptorsWrapper(onResponse: (response, handler) {
      // /auth/* is excluded deliberately: a wrong password on /auth/login
      // legitimately 401s and must show as "invalid credentials," not
      // "session expired" (the user isn't authenticated yet at all), and
      // /auth/me's own 401 on a cold start with no cookie is the normal,
      // expected "not logged in" case AuthController already handles
      // directly via its result.isSuccess check.
      final isAuthEndpoint = response.requestOptions.path.startsWith('/auth/');
      if (response.statusCode == 401 && !isAuthEndpoint) {
        client._sessionExpiredController.add(null);
      }
      handler.next(response);
    }));
    return client;
  }

  Future<ApiResult<T>> get<T>(String path, {Map<String, dynamic>? query, T Function(dynamic)? parse}) =>
      _request('GET', path, query: query, parse: parse);

  Future<ApiResult<T>> post<T>(String path, {Object? body, T Function(dynamic)? parse, Duration? receiveTimeout}) =>
      _request('POST', path, body: body, parse: parse, receiveTimeout: receiveTimeout);

  Future<ApiResult<T>> patch<T>(String path, {Object? body, T Function(dynamic)? parse}) =>
      _request('PATCH', path, body: body, parse: parse);

  Future<ApiResult<T>> delete<T>(String path, {T Function(dynamic)? parse}) =>
      _request('DELETE', path, parse: parse);

  /// Multipart upload — used by the chat composer's attach-a-photo flow.
  /// Passing a Dio `FormData` body makes Dio compute and send the correct
  /// `multipart/form-data; boundary=...` content type for this request only,
  /// overriding the client's default `application/json` header.
  Future<ApiResult<T>> uploadFile<T>(String path, File file, {Map<String, String>? fields, T Function(dynamic)? parse}) async {
    try {
      final formData = FormData.fromMap({
        ...?fields,
        'file': await MultipartFile.fromFile(file.path, filename: file.path.split('/').last),
      });
      final res = await _dio.post(path, data: formData);
      if (res.statusCode != null && res.statusCode! >= 200 && res.statusCode! < 300) {
        final data = parse != null ? parse(res.data) : res.data as T;
        return ApiResult.success(data);
      }
      final errorMessage = (res.data is Map && res.data['error'] != null) ? res.data['error'] as String : 'Upload failed (${res.statusCode}).';
      return ApiResult.failure(errorMessage, statusCode: res.statusCode);
    } on DioException catch (e) {
      return ApiResult.failure(e.message ?? 'Upload failed.');
    }
  }

  /// Multipart upload with a fixed 'audio' field name (plus optional plain
  /// text fields, e.g. agentId/conversationId) — used by the voice composer's
  /// record-a-message flow. Kept separate from uploadFile() above rather than
  /// generalizing it, since that method is already in use for the photo
  /// attach flow and changing its signature would touch an unrelated feature.
  Future<ApiResult<T>> uploadAudio<T>(String path, File file, {Map<String, String>? fields, T Function(dynamic)? parse}) async {
    try {
      final formData = FormData.fromMap({
        ...?fields,
        'audio': await MultipartFile.fromFile(file.path, filename: file.path.split('/').last),
      });
      final res = await _dio.post(path, data: formData);
      if (res.statusCode != null && res.statusCode! >= 200 && res.statusCode! < 300) {
        final data = parse != null ? parse(res.data) : res.data as T;
        return ApiResult.success(data);
      }
      final errorMessage = (res.data is Map && res.data['error'] != null) ? res.data['error'] as String : 'Upload failed (${res.statusCode}).';
      return ApiResult.failure(errorMessage, statusCode: res.statusCode);
    } on DioException catch (e) {
      return ApiResult.failure(e.message ?? 'Upload failed.');
    }
  }

  /// POSTs a JSON body and reads back a raw binary response — used for
  /// text-to-speech audio, which unlike every other endpoint isn't JSON.
  Future<ApiResult<Uint8List>> postBytes(String path, {Object? body}) async {
    try {
      final res = await _dio.post(
        path,
        data: body,
        options: Options(method: 'POST', responseType: ResponseType.bytes),
      );
      if (res.statusCode != null && res.statusCode! >= 200 && res.statusCode! < 300) {
        return ApiResult.success(Uint8List.fromList(res.data as List<int>));
      }
      // Dio still hands back raw bytes for a JSON error response when
      // responseType is bytes — decode it to surface the real message.
      String errorMessage = 'Request failed (${res.statusCode}).';
      try {
        final decoded = jsonDecode(utf8.decode(res.data as List<int>));
        if (decoded is Map && decoded['error'] != null) errorMessage = decoded['error'] as String;
      } catch (_) {
        // Not decodable JSON — fall back to the generic message above.
      }
      return ApiResult.failure(errorMessage, statusCode: res.statusCode);
    } on DioException catch (e) {
      return ApiResult.failure(e.message ?? 'Network error.');
    }
  }

  /// GETs a raw binary response — used to download a file's actual bytes
  /// (as opposed to its JSON metadata) so they can be handed to share_plus
  /// for the OS's native "open with / share / save" sheet.
  Future<ApiResult<Uint8List>> getBytes(String path) async {
    try {
      final res = await _dio.get(path, options: Options(responseType: ResponseType.bytes));
      if (res.statusCode != null && res.statusCode! >= 200 && res.statusCode! < 300) {
        return ApiResult.success(Uint8List.fromList(res.data as List<int>));
      }
      String errorMessage = 'Request failed (${res.statusCode}).';
      try {
        final decoded = jsonDecode(utf8.decode(res.data as List<int>));
        if (decoded is Map && decoded['error'] != null) errorMessage = decoded['error'] as String;
      } catch (_) {
        // Not decodable JSON — fall back to the generic message above.
      }
      return ApiResult.failure(errorMessage, statusCode: res.statusCode);
    } on DioException catch (e) {
      return ApiResult.failure(e.message ?? 'Network error.');
    }
  }

  Future<ApiResult<T>> _request<T>(
    String method,
    String path, {
    Map<String, dynamic>? query,
    Object? body,
    T Function(dynamic)? parse,
    Duration? receiveTimeout,
  }) async {
    try {
      final res = await _dio.request(
        path,
        data: body,
        queryParameters: query,
        // A per-request override — most endpoints respond quickly and should
        // still time out at the client's normal 20s default, but a handful
        // (AI generation) can legitimately take much longer than any other
        // call in the app, and 20s was cutting those off client-side even
        // though the server request was still running and completed fine.
        options: Options(method: method, receiveTimeout: receiveTimeout),
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

  /// The current session cookie(s) for our own API host — used only to seed
  /// an in-app WebView's cookie store before navigating it to one of our
  /// own OAuth /connect endpoints (see integrations/presentation/
  /// oauth_webview_screen.dart). Never sent anywhere else; this just lets a
  /// second "browser" (the WebView) present the same already-authenticated
  /// session Dio is carrying, so requireAuth on the server accepts it.
  Future<List<Cookie>> cookiesForBaseUrl() => _cookieJar.loadForRequest(Uri.parse(baseUrl));
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
