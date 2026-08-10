import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/marketplace_models.dart';
import '../providers/marketplace_provider.dart';

class MarketplaceInstallsScreen extends ConsumerWidget {
  const MarketplaceInstallsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(myInstallsControllerProvider);
    final controller = ref.read(myInstallsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('My installs')),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : state.error != null
              ? Center(child: Text(state.error!, style: const TextStyle(color: Colors.red)))
              : state.installs.isEmpty
                  ? const Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text('Nothing installed yet — browse the Marketplace to add agents, automations, or prompts.',
                            textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: controller.load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: state.installs.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (context, i) => _InstallCard(install: state.installs[i], controller: controller),
                      ),
                    ),
    );
  }
}

class _InstallCard extends StatelessWidget {
  const _InstallCard({required this.install, required this.controller});
  final MarketplaceInstall install;
  final MyInstallsController controller;

  @override
  Widget build(BuildContext context) {
    final enabled = install.status == 'active';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(install.assetName, style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: (enabled ? Colors.green : Colors.grey).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(install.status, style: TextStyle(fontSize: 11, color: enabled ? Colors.green : Colors.grey)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              install.updateAvailable
                  ? 'v${install.installedVersion} (v${install.latestVersion} available)'
                  : 'v${install.installedVersion}',
              style: const TextStyle(fontSize: 12, color: Colors.grey),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                if (install.updateAvailable)
                  OutlinedButton(
                    onPressed: () => controller.update(install.id),
                    child: const Text('Update'),
                  ),
                OutlinedButton(
                  onPressed: () => controller.toggleEnabled(install.id, !enabled),
                  child: Text(enabled ? 'Disable' : 'Enable'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                  onPressed: () => _confirmUninstall(context),
                  child: const Text('Uninstall'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _confirmUninstall(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Uninstall?'),
        content: Text('This removes "${install.assetName}" from your account.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              Navigator.pop(dialogContext);
              controller.uninstall(install.id);
            },
            child: const Text('Uninstall', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}
