import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/api/api_client.dart';
import 'core/config/app_config.dart';
import 'firebase_options.dart';
import 'app.dart';

/// The API base URL is resolved from --dart-define values (see
/// core/config/app_config.dart) — nothing to edit here for a normal run.
///
/// - Local development, no flags: works as-is for an iOS
///   simulator/desktop (http://localhost:4000/api) or Android emulator
///   (http://10.0.2.2:4000/api — 10.0.2.2 is the emulator's alias for the
///   host machine's localhost; plain "localhost" won't reach it).
/// - A physical device, an ngrok tunnel, or a GitHub Codespace's forwarded
///   port: pass the real URL explicitly —
///   flutter run --dart-define=API_BASE_URL=https://your-tunnel-or-codespace-url/api
///   (for a Codespace, make sure port 4000's visibility is set to Public in
///   the Ports tab, or your phone won't be able to reach it).
/// - Staging/production builds: see DEPLOYMENT_RUNBOOK.md and
///   core/config/app_config.dart's doc comment — both ENVIRONMENT and
///   API_BASE_URL must be passed; there is no hardcoded fallback for
///   either, by design.
void main() async {
  ApiClient.baseUrl = AppConfig.apiBaseUrl;

  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  } catch (err) {
    // Push notifications just won't work on this run — everything else
    // about the app is independent of Firebase, so don't block startup.
    debugPrint('[push] Firebase init failed: $err');
  }

  runApp(const ProviderScope(child: AutopilonApp()));
}
