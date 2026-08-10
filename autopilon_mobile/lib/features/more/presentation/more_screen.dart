import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final sections = [
      (Icons.bolt_outlined, 'Automations', 'Workflows on a schedule or trigger', '/more/automations'),
      (Icons.power_outlined, 'Integrations', 'Connect the tools your agents use', '/more/integrations'),
      (Icons.storefront_outlined, 'Marketplace', 'Browse and install agents & automations', '/more/marketplace'),
      (Icons.receipt_long_outlined, 'Billing', 'Plan, usage, and payment details', '/more/billing'),
      // Analytics already lives on the Home tab (dashboard_screen.dart) —
      // pointing here instead of building a second copy of the same screen.
      (Icons.insights_outlined, 'Analytics', 'Usage and performance across your org', '/'),
      (Icons.settings_outlined, 'Settings', 'Account, appearance, and provider status', '/more/settings'),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: sections.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, i) {
          final s = sections[i];
          final route = s.$4;
          return Card(
            child: ListTile(
              leading: Icon(s.$1),
              title: Text(s.$2),
              subtitle: Text(s.$3, style: const TextStyle(fontSize: 12)),
              trailing: route == null
                  ? const Text('Soon', style: TextStyle(fontSize: 11, color: Colors.grey))
                  : const Icon(Icons.chevron_right),
              onTap: () {
                if (route != null) {
                  context.push(route);
                } else {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(SnackBar(content: Text('${s.$2} is coming in a later phase.')));
                }
              },
            ),
          );
        },
      ),
    );
  }
}
