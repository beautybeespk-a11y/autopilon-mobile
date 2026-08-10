import 'package:flutter/material.dart';

/// Placeholder — the router (Phase 12c) already links here from More, but
/// the real integrations UI (connect/manage tools) hasn't been built yet.
class IntegrationsScreen extends StatelessWidget {
  const IntegrationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Integrations')),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.power_outlined, size: 40, color: Colors.grey),
              SizedBox(height: 12),
              Text('Integrations are coming in a later phase.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
            ],
          ),
        ),
      ),
    );
  }
}
