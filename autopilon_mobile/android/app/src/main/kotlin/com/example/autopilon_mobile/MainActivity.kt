package com.example.autopilon_mobile

import io.flutter.embedding.android.FlutterFragmentActivity

// FlutterFragmentActivity, not the default FlutterActivity — local_auth's
// BiometricPrompt requires a FragmentActivity host to show the biometric
// dialog (Settings > Security app-lock toggle, Phase 12D). See pubspec.yaml's
// local_auth dependency comment.
class MainActivity : FlutterFragmentActivity()
