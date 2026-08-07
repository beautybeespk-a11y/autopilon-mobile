import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/agent_models.dart';
import '../providers/agent_provider.dart';

class AgentsScreen extends ConsumerWidget {
  const AgentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(agentsControllerProvider);
    final controller = ref.read(agentsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Agents'),
        actions: [
          TextButton.icon(
            onPressed: () => _notBuiltYet(context, 'Agent Library'),
            icon: const Icon(Icons.menu_book_outlined, size: 18),
            label: const Text('Library'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _notBuiltYet(context, 'New agent builder'),
        icon: const Icon(Icons.add),
        label: const Text('New agent'),
      ),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : state.agents.isEmpty
              ? _EmptyAgents(onCreate: () => _notBuiltYet(context, 'New agent builder'))
              : RefreshIndicator(
                  onRefresh: controller.load,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: state.agents.length,
                    itemBuilder: (context, i) => _AgentCard(
                      agent: state.agents[i],
                      busy: state.busyId == state.agents[i].id,
                    ),
                  ),
                ),
    );
  }

  static void _notBuiltYet(BuildContext context, String feature) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$feature is coming in a later phase.')),
    );
  }
}

class _EmptyAgents extends StatelessWidget {
  const _EmptyAgents({required this.onCreate});
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.smart_toy_outlined, size: 48, color: Colors.grey),
            const SizedBox(height: 12),
            const Text('No agents yet', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 4),
            const Text('Create your first agent — give it a persona and a few skills.',
                textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 16),
            FilledButton.icon(onPressed: onCreate, icon: const Icon(Icons.add), label: const Text('Create an agent')),
          ],
        ),
      ),
    );
  }
}

class _AgentCard extends ConsumerWidget {
  const _AgentCard({required this.agent, required this.busy});
  final Agent agent;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(agentsControllerProvider.notifier);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.primary.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(Icons.smart_toy_outlined, color: Theme.of(context).colorScheme.primary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(agent.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                      const SizedBox(height: 2),
                      Text(agent.description?.isNotEmpty == true ? agent.description! : 'No description.',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: Colors.grey)),
                    ],
                  ),
                ),
                if (busy)
                  const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                else
                  PopupMenuButton<String>(
                    onSelected: (v) {
                      switch (v) {
                        case 'toggle':
                          controller.toggleStatus(agent);
                          break;
                        case 'clone':
                          controller.clone(agent.id);
                          break;
                        case 'publish':
                          _showPublishDialog(context, ref, agent);
                          break;
                        case 'delete':
                          _confirmDelete(context, controller, agent);
                          break;
                      }
                    },
                    itemBuilder: (_) => [
                      PopupMenuItem(value: 'toggle', child: Text(agent.status == 'active' ? 'Deactivate' : 'Activate')),
                      const PopupMenuItem(value: 'clone', child: Text('Clone')),
                      if (agent.isOwner) const PopupMenuItem(value: 'publish', child: Text('Publish to Marketplace')),
                      const PopupMenuItem(value: 'delete', child: Text('Delete')),
                    ],
                  ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              children: [
                _tag(agent.status == 'active' ? 'Active' : 'Inactive',
                    agent.status == 'active' ? Colors.green : Colors.grey),
                _tag('v${agent.version}', Colors.grey),
                if (agent.scope != 'personal')
                  _tag(agent.scope == 'organization' ? 'Shared: org' : 'Shared: workspace',
                      Theme.of(context).colorScheme.primary),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _tag(String label, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(20)),
        child: Text(label, style: TextStyle(fontSize: 11, color: color)),
      );

  void _confirmDelete(BuildContext context, AgentsController controller, Agent agent) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete agent?'),
        content: Text('This will permanently delete "${agent.name}".'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              Navigator.pop(ctx);
              controller.delete(agent.id);
            },
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  void _showPublishDialog(BuildContext context, WidgetRef ref, Agent agent) {
    final nameCtrl = TextEditingController(text: agent.name);
    final descCtrl = TextEditingController(text: agent.description ?? '');
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Publish to Marketplace'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Listing name')),
            const SizedBox(height: 8),
            TextField(controller: descCtrl, decoration: const InputDecoration(labelText: 'Description'), maxLines: 3),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () async {
              final ok = await ref
                  .read(agentsControllerProvider.notifier)
                  .publish(agent.id, nameCtrl.text, descCtrl.text);
              if (ctx.mounted) Navigator.pop(ctx);
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text(ok ? 'Listing created.' : 'Could not publish — try again.')),
                );
              }
            },
            child: const Text('Create listing'),
          ),
        ],
      ),
    );
  }
}
