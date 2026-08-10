import 'package:flutter/material.dart';

/// Placeholder — the router (Phase 12c) already links here from More, but
/// the real automations UI (list/create workflows) hasn't been built yet.
class AutomationsScreen extends StatelessWidget {
  const AutomationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Automations')),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.bolt_outlined, size: 40, color: Colors.grey),
              SizedBox(height: 12),
              Text('Automations are coming in a later phase.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
            ],
          ),
        ),
      ),
    );
  }
}
