import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/api/api_client.dart';
import 'firebase_options.dart';
import 'app.dart';

/// The one thing you MUST edit before running this: point ApiClient.baseUrl
/// at your actual running Autopilon server.
///
/// - Android emulator talking to a server on your own machine: use
///   https://isotope-dipping-cobweb.ngrok-free.dev/api (10.0.2.2 is the emulator's alias for your
///   host machine's localhost — plain "localhost" won't reach it).
/// - Physical device, or server running in a GitHub Codespace: use the
///   Codespace's forwarded HTTPS URL for port 4000, e.g.
///   https://<your-codespace-name>-4000.app.github.dev/api
///   (make sure that port's visibility is set to Public in the Codespace's
///   Ports tab, or your phone won't be able to reach it).
/// - iOS simulator on the same Mac as the server: http://localhost:4000/api
///   works as-is.
void main() async {
  ApiClient.baseUrl = 'https://isotope-dipping-cobweb.ngrok-free.dev/api';

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
