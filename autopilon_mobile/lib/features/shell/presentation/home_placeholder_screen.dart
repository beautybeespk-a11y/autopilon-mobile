import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';

/// Deliberately minimal — this is the foundation phase. Real dashboard
/// widgets (AI activity, agents, projects, tasks, usage, billing summary)
/// are Phase 12B, once this shell + auth + navigation is confirmed working
/// on a real device.
class HomePlaceholderScreen extends ConsumerWidget {
  const HomePlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authControllerProvider).user;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle_outline, size: 48, color: Colors.green),
            const SizedBox(height: 16),
            Text('Signed in as ${user?.name ?? '...'}', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              'Phase 12A foundation — auth, API client, theme, navigation, and organization switching are wired up. '
              'The real dashboard (agents, tasks, usage, billing) arrives in Phase 12B.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}
