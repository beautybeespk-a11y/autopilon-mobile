import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/integration_models.dart';
import '../data/manual_connect_fields.dart';
import '../providers/integration_provider.dart';
import 'oauth_connect_webview_screen.dart';

class IntegrationsScreen extends ConsumerWidget {
  const IntegrationsScreen({super.key});

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
                        Text(state.error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
                        const SizedBox(height: 12),
                        OutlinedButton(onPressed: controller.load, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: controller.load,
                  child: ListView.separated(
                    padding: const EdgeInsets.all(12),
                    itemCount: state.items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) => _IntegrationCard(item: state.items[i], busy: state.actionBusy),
                  ),
                ),
    );
  }
}

class _IntegrationCard extends ConsumerWidget {
  const _IntegrationCard({required this.item, required this.busy});
  final IntegrationItem item;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(integrationControllerProvider.notifier);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(item.name, style: const TextStyle(fontWeight: FontWeight.w600))),
                _StatusBadge(item: item),
              ],
            ),
            if (item.connected && item.phoneNumber != null) ...[
              const SizedBox(height: 4),
              Text(item.phoneNumber!, style: const TextStyle(fontSize: 12, color: Colors.grey)),
            ],
            if (item.setupRequired != null) ...[
              const SizedBox(height: 6),
              Text('Needs setup by the app owner: ${item.setupRequired}', style: const TextStyle(fontSize: 12, color: Colors.grey)),
            ],
            const SizedBox(height: 10),
            _ActionRow(item: item, busy: busy, controller: controller),
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
    final (label, color) = item.sharedFromOrg
        ? ('Shared from org', Colors.blue)
        : item.connected
            ? ('Connected', Colors.green)
            : ('Not connected', Colors.grey);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(label, style: TextStyle(fontSize: 11, color: color)),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.item, required this.busy, required this.controller});
  final IntegrationItem item;
  final bool busy;
  final IntegrationController controller;

  @override
  Widget build(BuildContext context) {
    if (!item.available) {
      return const SizedBox(width: double.infinity, child: OutlinedButton(onPressed: null, child: Text('Coming soon')));
    }
    if (item.sharedFromOrg) {
      return const SizedBox(width: double.infinity, child: OutlinedButton(onPressed: null, child: Text('Managed by your organization')));
    }
    if (item.connected) {
      return SizedBox(
        width: double.infinity,
        child: OutlinedButton(
          style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
          onPressed: busy ? null : () => _confirmDisconnect(context),
          child: const Text('Disconnect'),
        ),
      );
    }
    final disabled = busy || item.setupRequired != null;
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        onPressed: disabled ? null : () => _connect(context),
        child: const Text('Connect'),
      ),
    );
  }

  Future<void> _connect(BuildContext context) async {
    if (item.connectType == 'manual') {
      await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (_) => _ManualConnectSheet(provider: item.provider, controller: controller),
      );
      return;
    }
    if (item.connectType == 'redirect' && item.connectPath != null) {
      final result = await Navigator.of(context).push<bool?>(
        MaterialPageRoute(builder: (_) => OAuthConnectWebViewScreen(connectPath: item.connectPath!, providerName: item.name)),
      );
      await controller.load();
      if (result == true && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${item.name} connected.')));
      }
    }
  }

  void _confirmDisconnect(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Disconnect?'),
        content: Text('This revokes ${item.name}\'s access and removes the stored connection.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              final error = await controller.disconnect(item.provider);
              if (error != null && context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
              }
            },
            child: const Text('Disconnect', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}

/// Generic manual-connect form driven by manualConnectFields — mirrors the
/// web client's ManualConnectForm. Only used for non-OAuth integrations
/// (WhatsApp, WordPress, WooCommerce, Shopify); none of these fields are
/// Meta App ID/Secret.
class _ManualConnectSheet extends StatefulWidget {
  const _ManualConnectSheet({required this.provider, required this.controller});
  final String provider;
  final IntegrationController controller;

  @override
  State<_ManualConnectSheet> createState() => _ManualConnectSheetState();
}

class _ManualConnectSheetState extends State<_ManualConnectSheet> {
  late final Map<String, TextEditingController> _controllers;
  bool _busy = false;
  String? _error;

  List<ManualField> get _fields => manualConnectFields[widget.provider] ?? [];

  @override
  void initState() {
    super.initState();
    _controllers = {for (final f in _fields) f.key: TextEditingController()};
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _missingRequired => _fields.any((f) => f.required && (_controllers[f.key]?.text.trim().isEmpty ?? true));

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final values = {for (final f in _fields) f.key: _controllers[f.key]!.text.trim()};
    final error = await widget.controller.manualConnect(widget.provider, values);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error == null) {
      Navigator.of(context).pop();
    } else {
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(left: 16, right: 16, top: 16, bottom: MediaQuery.of(context).viewInsets.bottom + 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Connect ${widget.provider}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
          const SizedBox(height: 12),
          ..._fields.map((f) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: TextField(
                  controller: _controllers[f.key],
                  obscureText: f.obscure,
                  onChanged: (_) => setState(() {}), // re-evaluate _missingRequired to enable/disable Connect
                  decoration: InputDecoration(labelText: f.label, hintText: f.placeholder, border: const OutlineInputBorder()),
                ),
              )),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: Colors.red))),
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  onPressed: _busy || _missingRequired ? null : _submit,
                  child: Text(_busy ? 'Verifying…' : 'Connect'),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Icon(Icons.close, size: 18)),
            ],
          ),
        ],
      ),
    );
  }
}
