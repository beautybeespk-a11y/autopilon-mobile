import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../../auth/providers/auth_provider.dart';

/// Result of a completed OAuth round trip, returned via Navigator.pop.
class OAuthResult {
  final bool success;
  final String? error;
  const OAuthResult.success() : success = true, error = null;
  const OAuthResult.failure(this.error) : success = false;
}

/// In-app browser for the Meta/Gmail/Google-service "Connect" flow.
///
/// Those flows start at our own GET /api/integrations/<provider>/connect,
/// which is behind requireAuth — it needs the same session cookie every
/// other authenticated request in this app already carries. Handing the URL
/// to the system browser (as billing_screen.dart does for Stripe checkout)
/// would fail here: the system browser has no session cookie, and would
/// just land on the login page instead of being redirected on to Facebook/
/// Google. So this WebView is seeded with the app's own session cookie
/// before it navigates anywhere, and it never leaves the app.
///
/// The provider's OAuth consent screen and (for Meta) its asset picker are
/// Meta's/Google's own pages — real web content the WebView renders as-is,
/// not something this app can skin or skip. Completion is detected by
/// watching for the server's own redirect back to `/app/integrations`
/// (server/routes/metaAuth.js, gmailAuth.js, googleServiceAuth.js all
/// redirect there on both success and failure) — at that point the
/// connection has already been saved server-side, so this screen just pops
/// with the result instead of letting the WebView load the full web app.
class OAuthWebViewScreen extends ConsumerStatefulWidget {
  const OAuthWebViewScreen({super.key, required this.connectUrl, required this.title});
  final String connectUrl;
  final String title;

  @override
  ConsumerState<OAuthWebViewScreen> createState() => _OAuthWebViewScreenState();
}

class _OAuthWebViewScreenState extends ConsumerState<OAuthWebViewScreen> {
  WebViewController? _controller;
  bool _pageLoading = true;
  String? _initError;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final apiClient = await ref.read(apiClientProvider.future);
      final cookies = await apiClient.cookiesForBaseUrl();
      final target = Uri.parse(widget.connectUrl);

      final cookieManager = WebViewCookieManager();
      for (final cookie in cookies) {
        await cookieManager.setCookie(WebViewCookie(
          name: cookie.name,
          value: cookie.value,
          domain: target.host,
          path: '/',
        ));
      }

      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setNavigationDelegate(NavigationDelegate(
          onPageStarted: (_) => mounted ? setState(() => _pageLoading = true) : null,
          onPageFinished: (_) => mounted ? setState(() => _pageLoading = false) : null,
          onNavigationRequest: (request) => _handleNavigation(request.url),
        ))
        ..loadRequest(target);

      if (!mounted) return;
      setState(() => _controller = controller);
    } catch (e) {
      if (mounted) setState(() => _initError = "Couldn't start the connection.");
    }
  }

  NavigationDecision _handleNavigation(String url) {
    final uri = Uri.tryParse(url);
    // Every provider's callback route redirects here (see class doc) —
    // reaching it at all means the server has already finished saving (or
    // failed to save) the connection, so intercept before the WebView
    // actually renders the web app and pop back to the native screen.
    if (uri != null && uri.path == '/app/integrations') {
      final errorParam = uri.queryParameters.entries.firstWhere(
        (e) => e.key.endsWith('_error'),
        orElse: () => const MapEntry('', ''),
      );
      Navigator.of(context).pop(
        errorParam.value.isNotEmpty ? OAuthResult.failure(errorParam.value) : const OAuthResult.success(),
      );
      return NavigationDecision.prevent;
    }
    return NavigationDecision.navigate;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: _initError != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_initError!, textAlign: TextAlign.center),
              ),
            )
          : _controller == null
              ? const Center(child: CircularProgressIndicator())
              : Stack(
                  children: [
                    WebViewWidget(controller: _controller!),
                    if (_pageLoading) const LinearProgressIndicator(minHeight: 2),
                  ],
                ),
    );
  }
}
