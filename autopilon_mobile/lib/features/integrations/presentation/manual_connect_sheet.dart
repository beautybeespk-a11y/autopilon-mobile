import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/integration_models.dart';
import '../providers/integration_provider.dart';

/// Form for the manual-token integrations (WhatsApp, WordPress, WooCommerce,
/// Shopify) — driven by kManualIntegrationFields, mirroring the web client's
/// generic MANUAL_FIELDS-driven ManualConnectForm so both clients ask for
/// the same fields in the same order. None of these go through Meta/Google
/// OAuth; the user pastes credentials they generated themselves in that
/// provider's own dashboard.
Future<void> showManualConnectSheet(BuildContext context, WidgetRef ref, IntegrationItem item) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => _ManualConnectSheet(item: item),
  );
}

class _ManualConnectSheet extends ConsumerStatefulWidget {
  const _ManualConnectSheet({required this.item});
  final IntegrationItem item;

  @override
  ConsumerState<_ManualConnectSheet> createState() => _ManualConnectSheetState();
}

class _ManualConnectSheetState extends ConsumerState<_ManualConnectSheet> {
  late final List<ManualField> _fields = kManualIntegrationFields[widget.item.provider] ?? const [];
  late final Map<String, TextEditingController> _controllers = {
    for (final f in _fields) f.key: TextEditingController(),
  };
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _missingRequired => _fields.any((f) => f.required && (_controllers[f.key]?.text.trim().isEmpty ?? true));

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    final fields = {for (final f in _fields) f.key: _controllers[f.key]!.text.trim()};
    final error = await ref.read(integrationControllerProvider.notifier).connectManual(widget.item.provider, fields);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
    } else {
      setState(() { _busy = false; _error = error; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16, right: 16, top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Connect ${widget.item.name}', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            for (final f in _fields) ...[
              TextField(
                controller: _controllers[f.key],
                obscureText: f.obscure,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  labelText: f.required ? '${f.label} *' : f.label,
                  hintText: f.placeholder,
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
            ],
            if (_error != null) ...[
              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
              const SizedBox(height: 8),
            ],
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: _busy || _missingRequired ? null : _submit,
                    child: Text(_busy ? 'Connecting…' : 'Connect'),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
