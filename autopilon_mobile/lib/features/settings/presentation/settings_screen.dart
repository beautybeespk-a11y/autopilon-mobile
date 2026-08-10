import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/auth/biometric_gate.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/settings_provider.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authControllerProvider).user;
    final themeMode = ref.watch(themeModeControllerProvider);
    final providerAsync = ref.watch(providerStatusProvider);
    final biometricSupportAsync = ref.watch(biometricSupportProvider);
    final biometricEnabled = ref.watch(biometricLockEnabledProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Text('Manage your workspace preferences.',
              style: TextStyle(color: Theme.of(context).textTheme.bodySmall?.color)),
          const SizedBox(height: 14),

          _SectionCard(
            title: 'Account',
            icon: Icons.person_outline,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _row(context, 'Name', user?.name ?? '—'),
                _row(context, 'Email', user?.email ?? '—'),
                const SizedBox(height: 12),
                OutlinedButton(
                  onPressed: () => ref.read(authControllerProvider.notifier).logout(),
                  child: const Text('Log out'),
                ),
              ],
            ),
          ),

          _SectionCard(
            title: 'Appearance',
            icon: Icons.palette_outlined,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Theme', style: TextStyle(color: Theme.of(context).textTheme.bodySmall?.color)),
                OutlinedButton.icon(
                  onPressed: () => ref.read(themeModeControllerProvider.notifier).toggle(),
                  icon: Icon(themeMode == ThemeMode.dark ? Icons.dark_mode_outlined : Icons.light_mode_outlined, size: 16),
                  label: Text(themeMode == ThemeMode.dark ? 'Dark' : 'Light'),
                ),
              ],
            ),
          ),

          _SectionCard(
            title: 'AI provider',
            icon: Icons.memory_outlined,
            child: providerAsync.when(
              loading: () => Text('Checking provider status…',
                  style: TextStyle(fontSize: 13, color: Theme.of(context).textTheme.bodySmall?.color)),
              error: (_, __) => const Text('Could not check provider status.', style: TextStyle(fontSize: 13)),
              data: (provider) {
                if (provider == null) {
                  return const Text('Could not check provider status.', style: TextStyle(fontSize: 13));
                }
                final configured = provider.configured;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: (configured ? Colors.teal : Colors.amber).withOpacity(0.1),
                        border: Border.all(color: (configured ? Colors.teal : Colors.amber).withOpacity(0.3)),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        children: [
                          Icon(configured ? Icons.check_circle_outline : Icons.warning_amber_rounded,
                              size: 16, color: configured ? Colors.teal : Colors.amber),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              configured
                                  ? '${provider.label} is configured and ready.'
                                  : 'AI provider not configured — ${provider.reason ?? "unknown reason"}',
                              style: TextStyle(fontSize: 13, color: configured ? Colors.teal : Colors.amber.shade800),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'Provider and API keys are set on the server via environment variables. Keys are never exposed to the app.',
                      style: TextStyle(fontSize: 11, color: Theme.of(context).textTheme.bodySmall?.color),
                    ),
                  ],
                );
              },
            ),
          ),

          _SectionCard(
            title: 'Security',
            icon: Icons.shield_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const _BulletLine('Authenticated routes are protected server-side.'),
                const _BulletLine('Sessions use secure cookie storage; passwords are hashed.'),
                const _BulletLine('You can only access your own data.'),
                const SizedBox(height: 10),
                biometricSupportAsync.when(
                  loading: () => const SizedBox.shrink(),
                  error: (_, __) => const SizedBox.shrink(),
                  data: (supported) => supported
                      ? Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Expanded(child: Text('Require biometric unlock', style: TextStyle(fontSize: 13))),
                            Switch(
                              value: biometricEnabled,
                              onChanged: (v) {
                                ref.read(biometricLockEnabledProvider.notifier).setEnabled(v);
                                ref.read(biometricGateControllerProvider.notifier).setEnabled(v);
                              },
                            ),
                          ],
                        )
                      : const Text('Biometric unlock isn\'t available on this device.', style: TextStyle(fontSize: 12, color: Colors.grey)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: TextStyle(fontSize: 13, color: Theme.of(context).textTheme.bodySmall?.color)),
            Text(value, style: const TextStyle(fontSize: 13)),
          ],
        ),
      );
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.icon, required this.child});
  final String title;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
              ],
            ),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }
}

class _BulletLine extends StatelessWidget {
  const _BulletLine(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('•  ', style: TextStyle(color: Theme.of(context).textTheme.bodySmall?.color)),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 13, color: Theme.of(context).textTheme.bodySmall?.color)),
          ),
        ],
      ),
    );
  }
}
