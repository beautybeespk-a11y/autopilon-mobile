import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/integration_models.dart';
import '../providers/integration_provider.dart';
import 'manual_connect_sheet.dart';
import 'oauth_webview_screen.dart';

const Map<String, IconData> _kIconByProvider = {
  'meta_ads': Icons.campaign_outlined,
  'whatsapp': Icons.chat_outlined,
  'gmail': Icons.mail_outline,
  'google_calendar': Icons.calendar_month_outlined,
  'google_drive': Icons.folder_outlined,
  'google_docs': Icons.description_outlined,
  'google_sheets': Icons.table_chart_outlined,
  'wordpress': Icons.language_outlined,
  'woocommerce': Icons.shopping_cart_outlined,
  'shopify': Icons.storefront_outlined,
  'slack': Icons.forum_outlined,
  'telegram': Icons.send_outlined,
};

class IntegrationsScreen extends ConsumerWidget {
  const IntegrationsScreen({super.key});

  Future<void> _connect(BuildContext context, WidgetRef ref, IntegrationItem item) async {
    if (item.setupRequired != null) return;
    if (item.connectType == 'manual') {
      await showManualConnectSheet(context, ref, item);
      return;
    }
    if (item.connectType == 'redirect' && item.connectPath != null) {
      final repo = ref.read(integrationRepositoryProvider);
      final url = repo.oauthUrl(item.connectPath!);
      final result = await Navigator.of(context).push<OAuthResult>(
        MaterialPageRoute(builder: (_) => OAuthWebViewScreen(connectUrl: url, title: 'Connect ${item.name}')),
      );
      if (!context.mounted || result == null) return;
      await ref.read(integrationControllerProvider.notifier).refresh();
      if (!context.mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      if (result.success) {
        messenger.showSnackBar(SnackBar(content: Text('${item.name} connected.')));
      } else if (result.error != null) {
        messenger.showSnackBar(SnackBar(content: Text(result.error!)));
      }
    }
  }

  Future<void> _disconnect(BuildContext context, WidgetRef ref, IntegrationItem item) async {
    await ref.read(integrationControllerProvider.notifier).disconnect(item.provider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(integrationControllerProvider);
    final controller = ref.read(integrationControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Integrations')),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : state.error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(state.error!, style: const TextStyle(color: Colors.red), textAlign: TextAlign.center),
                        const SizedBox(height: 12),
                        FilledButton(onPressed: controller.refresh, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : state.items.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.power_outlined, size: 40, color: Colors.grey),
                            SizedBox(height: 12),
                            Text('No integrations available', textAlign: TextAlign.center),
                          ],
                        ),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: controller.refresh,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: state.items.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (context, i) => _IntegrationCard(
                          item: state.items[i],
                          onConnect: () => _connect(context, ref, state.items[i]),
                          onDisconnect: () => _disconnect(context, ref, state.items[i]),
                        ),
                      ),
                    ),
    );
  }
}

class _IntegrationCard extends StatelessWidget {
  const _IntegrationCard({required this.item, required this.onConnect, required this.onDisconnect});
  final IntegrationItem item;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    final icon = _kIconByProvider[item.provider] ?? Icons.extension_outlined;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 20,
              backgroundColor: Theme.of(context).colorScheme.primary.withOpacity(0.08),
              child: Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(item.name, style: const TextStyle(fontWeight: FontWeight.w600))),
                      if (item.note != null)
                        Chip(label: Text(item.note!, style: const TextStyle(fontSize: 10)), visualDensity: VisualDensity.compact, padding: EdgeInsets.zero),
                    ],
                  ),
                  const SizedBox(height: 4),
                  _StatusBadge(item: item),
                  if (item.connected && item.phoneNumber != null) ...[
                    const SizedBox(height: 4),
                    Text(item.phoneNumber!, style: const TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                  if (item.setupRequired != null) ...[
                    const SizedBox(height: 6),
                    Text('Needs setup by the app owner: ${item.setupRequired}', style: const TextStyle(fontSize: 11, color: Colors.grey)),
                  ],
                  const SizedBox(height: 10),
                  _ActionButton(item: item, onConnect: onConnect, onDisconnect: onDisconnect),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.item});
  final IntegrationItem item;

  @override
  Widget build(BuildContext context) {
    if (item.sharedFromOrg) {
      return const Text('Shared from your organization', style: TextStyle(fontSize: 12, color: Colors.blue));
    }
    return Text(
      item.connected ? 'Connected' : 'Not connected',
      style: TextStyle(fontSize: 12, color: item.connected ? Colors.green : Colors.grey),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.item, required this.onConnect, required this.onDisconnect});
  final IntegrationItem item;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    if (!item.available) {
      return const SizedBox(
        width: double.infinity,
        child: OutlinedButton(onPressed: null, child: Text('Coming soon')),
      );
    }
    if (item.sharedFromOrg) {
      return const SizedBox(
        width: double.infinity,
        child: OutlinedButton(onPressed: null, child: Text('Managed by your organization')),
      );
    }
    if (item.connected) {
      return SizedBox(
        width: double.infinity,
        child: OutlinedButton.icon(
          onPressed: onDisconnect,
          icon: const Icon(Icons.link_off, size: 16),
          label: const Text('Disconnect'),
        ),
      );
    }
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        onPressed: item.setupRequired != null ? null : onConnect,
        child: const Text('Connect'),
      ),
    );
  }
}
