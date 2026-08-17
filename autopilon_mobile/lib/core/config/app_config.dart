import 'dart:io';

/// Environment configuration (Phase 18 §32) — resolved entirely from
/// --dart-define values passed at build/run time, so the same source
/// tree produces a dev, staging, or production build without editing any
/// file. Replaces the previous hardcoded ngrok URL in main.dart.
///
/// Usage:
///   flutter run                                             # development, sensible emulator/simulator default
///   flutter run --dart-define=API_BASE_URL=https://abc.ngrok-free.dev/api   # dev, pointed at a specific tunnel
///   flutter build apk --dart-define=ENVIRONMENT=staging --dart-define=API_BASE_URL=https://staging-api.example.com/api
///   flutter build apk --dart-define=ENVIRONMENT=production --dart-define=API_BASE_URL=https://api.example.com/api
enum AppEnvironment { development, staging, production }

class AppConfig {
  AppConfig._();

  static const String _envName = String.fromEnvironment('ENVIRONMENT', defaultValue: 'development');
  static const String _apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');

  static AppEnvironment get environment {
    switch (_envName) {
      case 'production':
        return AppEnvironment.production;
      case 'staging':
        return AppEnvironment.staging;
      default:
        return AppEnvironment.development;
    }
  }

  static bool get isProduction => environment == AppEnvironment.production;
  static bool get isDevelopment => environment == AppEnvironment.development;

  /// Resolves the API base URL:
  /// 1. --dart-define=API_BASE_URL=... always wins when present — the
  ///    right way to point at an ngrok tunnel, a Codespace forwarded port,
  ///    or a real staging/production API domain, without editing source.
  /// 2. In development only, falls back to a per-platform default that
  ///    reaches a server running on the same host machine (10.0.2.2 is the
  ///    Android emulator's alias for the host's localhost; iOS
  ///    simulator/desktop can reach the host directly via localhost).
  /// 3. staging/production have NO hardcoded fallback domain — there is no
  ///    real provisioned API domain for either yet (see
  ///    EXTERNAL_INFRASTRUCTURE.md). A staging/production build that
  ///    doesn't pass API_BASE_URL fails loudly at startup instead of
  ///    silently pointing at a fake or wrong host.
  static String get apiBaseUrl {
    if (_apiBaseUrlOverride.isNotEmpty) return _apiBaseUrlOverride;
    if (environment == AppEnvironment.development) return _developmentDefaultUrl;
    throw StateError(
      'No API_BASE_URL configured for the "$_envName" environment. '
      'Build with --dart-define=API_BASE_URL=https://your-real-api-domain/api — '
      'see DEPLOYMENT_RUNBOOK.md for the real staging/production domains once provisioned.',
    );
  }

  // NOTE (Phase 18 §32/§33): this is plain HTTP, fine for the Android
  // emulator/iOS simulator talking to a server on the same host, but a
  // REAL Android device (or emulator on API 28+) blocks cleartext HTTP by
  // default — this default will only work there if the project's
  // android/app/src/main/AndroidManifest.xml carries a
  // networkSecurityConfig allowlisting 10.0.2.2/localhost specifically
  // for cleartext (never a blanket "allow all cleartext"). That manifest
  // doesn't exist in this repo yet — the android/ and ios/ platform
  // folders here are not fully scaffolded (no Flutter SDK was available
  // in any environment this project has been built in to run `flutter
  // create`/`flutter build`), so there is nothing to edit yet. Add it
  // when those folders are generated; until then, prefer an HTTPS tunnel
  // (ngrok/Codespace) via --dart-define=API_BASE_URL for testing on a
  // real device. Production builds are unaffected either way — they
  // require an explicit HTTPS API_BASE_URL and never reach this fallback.
  static String get _developmentDefaultUrl {
    if (!Platform.isAndroid) return 'http://localhost:4000/api';
    return 'http://10.0.2.2:4000/api';
  }
}
