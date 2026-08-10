import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../data/automation_models.dart';
import '../providers/automation_provider.dart';

const _statusColor = {'active': Colors.green, 'paused': Colors.orange, 'draft': Colors.grey};

class AutomationsScreen extends ConsumerWidget {
  const AutomationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(automationsControllerProvider);
    final controller = ref.read(automationsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Automations')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/more/automations/new'),
        icon: const Icon(Icons.add),
        label: const Text('New workflow'),
      ),
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
                        FilledButton(onPressed: controller.load, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: controller.load,
                  child: ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      if (state.dashboard != null) _DashboardStats(dashboard: state.dashboard!),
                      const SizedBox(height: 8),
                      if (state.automations.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(24),
                          child: Center(
                            child: Text('No workflows yet — create one to automate a repeated task.', style: TextStyle(color: Colors.grey)),
                          ),
                        )
                      else
                        ...state.automations.map((a) => _AutomationCard(
                              automation: a,
                              busy: state.busyId == a.id,
                              controller: controller,
                            )),
                      const SizedBox(height: 72), // keep the last card clear of the FAB
                    ],
                  ),
                ),
    );
  }
}

class _DashboardStats extends StatelessWidget {
  const _DashboardStats({required this.dashboard});
  final AutomationDashboard dashboard;

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 2.0,
      children: [
        _stat(context, 'Active', '${dashboard.activeWorkflows}', Icons.play_circle_outline),
        _stat(context, 'Paused', '${dashboard.pausedWorkflows}', Icons.pause_circle_outline),
        _stat(context, "Today's runs", '${dashboard.todaysExecutions}', Icons.today_outlined),
        _stat(context, 'Success rate', '${dashboard.successRate}%', Icons.check_circle_outline),
      ],
    );
  }

  Widget _stat(BuildContext context, String label, String value, IconData icon) => Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
                ],
              ),
            ],
          ),
        ),
      );
}

class _AutomationCard extends StatefulWidget {
  const _AutomationCard({required this.automation, required this.busy, required this.controller});
  final Automation automation;
  final bool busy;
  final AutomationsController controller;

  @override
  State<_AutomationCard> createState() => _AutomationCardState();
}

class _AutomationCardState extends State<_AutomationCard> {
  bool _showRuns = false;

  @override
  Widget build(BuildContext context) {
    final a = widget.automation;
    final color = _statusColor[a.status] ?? Colors.grey;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(a.name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
                if (widget.busy)
                  const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              ],
            ),
            if (a.description?.isNotEmpty == true) ...[
              const SizedBox(height: 2),
              Text(a.description!, style: const TextStyle(fontSize: 12, color: Colors.grey), maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                _tag(a.status, color),
                _tag(a.triggerType, Colors.grey),
                if (a.orgId != null) _tag(a.workspaceId != null ? 'Shared: workspace' : 'Shared: org', Theme.of(context).colorScheme.primary),
              ],
            ),
            if (a.lastRunAt != null || a.nextRunAt != null) ...[
              const SizedBox(height: 6),
              Text(
                [
                  if (a.lastRunAt != null) 'Last run: ${a.lastRunAt!.split("T").first}',
                  if (a.nextRunAt != null) 'Next run: ${a.nextRunAt!.split("T").first}',
                ].join('  ·  '),
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              children: [
                TextButton.icon(
                  onPressed: widget.busy ? null : () => widget.controller.runNow(a.id),
                  icon: const Icon(Icons.play_arrow, size: 16),
                  label: const Text('Run', style: TextStyle(fontSize: 12)),
                ),
                TextButton.icon(
                  onPressed: widget.busy ? null : () => widget.controller.togglePause(a),
                  icon: Icon(a.status == 'active' ? Icons.pause : Icons.play_circle_outline, size: 16),
                  label: Text(a.status == 'active' ? 'Pause' : 'Activate', style: const TextStyle(fontSize: 12)),
                ),
                TextButton.icon(
                  onPressed: () => context.push('/more/automations/${a.id}/edit'),
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  label: const Text('Edit', style: TextStyle(fontSize: 12)),
                ),
                TextButton.icon(
                  onPressed: () => setState(() => _showRuns = !_showRuns),
                  icon: Icon(_showRuns ? Icons.expand_less : Icons.expand_more, size: 16),
                  label: const Text('Runs', style: TextStyle(fontSize: 12)),
                ),
                TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: Colors.red),
                  onPressed: () => _confirmDelete(context),
                  icon: const Icon(Icons.delete_outline, size: 16),
                  label: const Text('Delete', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            if (_showRuns) _RunsList(automationId: a.id),
          ],
        ),
      ),
    );
  }

  Widget _tag(String label, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(20)),
        child: Text(label, style: TextStyle(fontSize: 11, color: color)),
      );

  void _confirmDelete(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete workflow?'),
        content: Text('This will permanently delete "${widget.automation.name}".'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              Navigator.pop(dialogContext);
              widget.controller.delete(widget.automation.id);
            },
            child: const Text('Delete', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}

class _RunsList extends ConsumerWidget {
  const _RunsList({required this.automationId});
  final String automationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runsAsync = ref.watch(automationRunsControllerProvider(automationId));
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
      child: runsAsync.when(
        data: (runs) => runs.isEmpty
            ? const Text('No runs yet.', style: TextStyle(fontSize: 12, color: Colors.grey))
            : Column(
                children: runs
                    .map((r) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Row(
                            children: [
                              Icon(
                                r.status == 'completed'
                                    ? Icons.check_circle_outline
                                    : r.status == 'failed'
                                        ? Icons.cancel_outlined
                                        : Icons.schedule_outlined,
                                size: 14,
                                color: r.status == 'completed'
                                    ? Colors.green
                                    : r.status == 'failed'
                                        ? Colors.red
                                        : Colors.grey,
                              ),
                              const SizedBox(width: 6),
                              Expanded(child: Text('${r.status}  ·  ${r.triggerSource ?? 'manual'}', style: const TextStyle(fontSize: 11))),
                              Text(r.createdAt.split('T').first, style: const TextStyle(fontSize: 10, color: Colors.grey)),
                            ],
                          ),
                        ))
                    .toList(),
              ),
        loading: () => const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        error: (e, _) => const Text('Could not load runs.', style: TextStyle(fontSize: 12, color: Colors.red)),
      ),
    );
  }
}
