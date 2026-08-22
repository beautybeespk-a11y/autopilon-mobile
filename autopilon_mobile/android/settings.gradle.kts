pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
    // Processes android/app/google-services.json — required for
    // firebase_core/firebase_messaging (Phase 12D push notifications) to
    // actually initialize. Not added by `flutter create`; only
    // `flutterfire configure` normally wires this, which wasn't available
    // to run against this checkout (no Flutter SDK existed in any sandbox
    // this project has used until this fix).
    id("com.google.gms.google-services") version "4.4.4" apply false
}

include(":app")
