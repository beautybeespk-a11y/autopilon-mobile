import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../../auth/providers/auth_provider.dart';
import '../../../core/api/api_client.dart';

/// Runs a provider's OAuth "Connect" flow (Meta, Gmail, Google Calendar/
/// Drive/Docs/Sheets — anything the catalog marks connectType: "redirect")
/// in an in-app WebView instead of a full page navigation, since a Flutter
/// app has no "current page" for the browser to redirect back to the way
/// the web client's `window.location.href = connectPath` does.
///
/// This is deliberately NOT a system-browser + custom-URL-scheme deep link.
/// The backend's /connect and /callback routes are gated by requireAuth,
/// which reads the same "autopilon.sid" session cookie this app's ApiClient
/// already carries — an in-app WebView is the one approach that can share
/// that cookie (copied in below) without inventing a second, token-based
/// auth path just for this flow. It also means:
///   - Meta's registered OAuth redirect_uri (META_REDIRECT_URI) is
///     completely untouched — it still points at the server's own
///     /api/integrations/<provider>/callback, exactly as it does for web.
///     Nothing here needs registering in the Meta App Dashboard.
///   - No custom URL scheme / Android intent-filter / iOS Associated
///     Domains work is required.
///   - The platform's App ID/App Secret never appear in this screen or
///     anywhere on-device — the WebView only ever loads the server's own
///     /connect URL, which redirects to Meta; the server does the token
///     exchange, as it already does for the web client.
///
/// Returns `true` via Navigator.pop once the flow lands back on
/// `/app/integrations` with a `*_connected=1` query param, `false` if it
/// lands there with a `*_error=...` param, or `null` if the user closes the
/// screen manually. Callers should re-fetch the integration list either way
/// — the server's saved connection state is the source of truth, not this
/// return value.
class OAuthConnectWebViewScreen extends ConsumerStatefulWidget {
  const OAuthConnectWebViewScreen({super.key, required this.connectPath, required this.providerName});

  /// Relative path from the CATALOG entry, e.g. "/api/integrations/meta/connect".
  final String connectPath;
  final String providerName;

  @override
  ConsumerState<OAuthConnectWebViewScreen> createState() => _OAuthConnectWebViewScreenState();
}

class _OAuthConnectWebViewScreenState extends ConsumerState<OAuthConnectWebViewScreen> {
  WebViewController? _controller;
  bool _loadingPage = true;
  String? _setupError;

  @override
  void initState() {
    super.initState();
    _setup();
  }

  Future<void> _setup() async {
    try {
      final apiClient = await ref.read(apiClientProvider.future);
      final root = Uri.parse(ApiClient.baseUrl);
      final targetUri = root.replace(path: widget.connectPath);

      // Copy this app's session cookie into the WebView's own (separate)
      // cookie store, scoped to our own host only — never sent to
      // facebook.com or any other domain the flow redirects through.
      final cookieManager = WebViewCookieManager();
      for (final cookie in await apiClient.sessionCookies()) {
        await cookieManager.setCookie(WebViewCookie(
          name: cookie.name,
          value: cookie.value,
          domain: root.host,
          path: '/',
        ));
      }

      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setNavigationDelegate(NavigationDelegate(
          onPageStarted: (_) => setState(() => _loadingPage = true),
          onPageFinished: (_) => setState(() => _loadingPage = false),
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            // Every provider's callback redirects back to this one web-app
            // path on success or failure (see metaAuth.js, gmail's oauth.js,
            // etc.) — detecting the path alone (not a specific provider's
            // query param) keeps this screen generic across all
            // connectType: "redirect" catalog entries.
            if (uri != null && uri.host == root.host && uri.path == '/app/integrations') {
              if (!mounted) return NavigationDecision.prevent;
              final hasError = uri.queryParameters.keys.any((k) => k.endsWith('_error'));
              final errorMessage = uri.queryParameters.entries.firstWhere((e) => e.key.endsWith('_error'), orElse: () => const MapEntry('', '')).value;
              if (hasError) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(errorMessage.isNotEmpty ? errorMessage : 'Connection failed.')));
              }
              Navigator.of(context).pop(hasError ? false : true);
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ))
        ..loadRequest(targetUri);

      if (!mounted) return;
      setState(() => _controller = controller);
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _loadingPage = false;
        _setupError = err.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Connect ${widget.providerName}'),
        leading: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.of(context).pop(null)),
      ),
      body: _setupError != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Could not start the connection: $_setupError', textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
              ),
            )
          : Stack(
              children: [
                if (_controller != null) WebViewWidget(controller: _controller!),
                if (_loadingPage) const Center(child: CircularProgressIndicator()),
              ],
            ),
    );
  }
}
