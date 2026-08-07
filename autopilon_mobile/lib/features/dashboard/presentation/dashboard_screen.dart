import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/dashboard_models.dart';
import '../providers/dashboard_provider.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  String _fmtCents(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(dashboardControllerProvider);

    if (state.loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(state.error!, style: const TextStyle(color: Colors.red)),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: () => ref.read(dashboardControllerProvider.notifier).refresh(),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    final dashboard = state.dashboard;
    if (dashboard == null) return const SizedBox.shrink();

    return RefreshIndicator(
      onRefresh: () => ref.read(dashboardControllerProvider.notifier).refresh(),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Enterprise Dashboard',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          Text('Organization-wide usage, activity, and performance.',
              style: TextStyle(color: Theme.of(context).textTheme.bodySmall?.color)),
          const SizedBox(height: 20),

          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 1.6,
            children: [
              _StatCard(
                icon: Icons.people_outline,
                label: 'Members',
                value: '${dashboard.members.total}',
                sub: '${dashboard.members.active} active · ${dashboard.members.invited} invited',
              ),
              _StatCard(
                icon: Icons.smart_toy_outlined,
                label: 'Agents',
                value: '${dashboard.agents.total}',
                sub: '${dashboard.agents.active} active',
              ),
              _StatCard(
                icon: Icons.bolt_outlined,
                label: 'Automations',
                value: '${dashboard.automations.total}',
                sub: '${dashboard.automations.runningNow} running now',
              ),
              _StatCard(
                icon: Icons.power_outlined,
                label: 'Integrations',
                value: '${dashboard.connectedIntegrations}',
                sub: '${dashboard.workspaceCount} workspaces',
              ),
            ],
          ),

          if (dashboard.securityAlerts.isNotEmpty) ...[
            const SizedBox(height: 20),
            Card(
              color: Colors.amber.withOpacity(0.08),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.amber.withOpacity(0.3)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: const [
                        Icon(Icons.warning_amber_rounded, color: Colors.amber, size: 18),
                        SizedBox(width: 8),
                        Text('Security alerts', style: TextStyle(fontWeight: FontWeight.bold)),
                      ],
                    ),
                    const SizedBox(height: 8),
                    ...dashboard.securityAlerts.map((a) => Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text('• ${a.title}'),
                        )),
                  ],
                ),
              ),
            ),
          ],

          if (state.cost != null) ...[
            const SizedBox(height: 20),
            _CostCard(cost: state.cost!, fmtCents: _fmtCents),
          ],

          if (state.analytics != null) ...[
            const SizedBox(height: 20),
            _MostUsedAgentsCard(analytics: state.analytics!),
            const SizedBox(height: 20),
            _WorkspaceActivityCard(analytics: state.analytics!),
          ],

          const SizedBox(height: 20),
          _RecentActivityCard(activity: dashboard.recentActivity),

          const SizedBox(height: 16),
          Text(
            "AI usage, token consumption, and API usage aren't shown here — "
            "this platform doesn't track those yet, so nothing is faked in their place.",
            style: TextStyle(fontSize: 12, color: Theme.of(context).textTheme.bodySmall?.color),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}
class _StatCard extends StatelessWidget {
  const _StatCard({required this.icon, required this.label, required this.value, required this.sub});
  final IconData icon;
  final String label;
  final String value;
  final String sub;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Row(children: [
              Icon(icon, size: 16, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 6),
              Text(label, style: const TextStyle(fontSize: 13)),
            ]),
            const SizedBox(height: 6),
            Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 2),
            Text(sub,
                style: TextStyle(fontSize: 11, color: Theme.of(context).textTheme.bodySmall?.color),
                overflow: TextOverflow.ellipsis),
          ],
        ),
      ),
    );
  }
}

class _CostCard extends StatelessWidget {
  const _CostCard({required this.cost, required this.fmtCents});
  final CostData cost;
  final String Function(int) fmtCents;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: _MiniStat(label: 'Estimated cost', value: fmtCents(cost.estimatedCostCents)),
                ),
                Expanded(
                  child: _MiniStat(
                    label: 'BYOK usage (not billed by us)',
                    value: fmtCents(cost.byokUsageCents),
                    sub: 'Paid directly to your own provider',
                  ),
                ),
              ],
            ),
            if (cost.byProvider.isNotEmpty) ...[
              const SizedBox(height: 16),
              const Text('By provider', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(height: 6),
              ...cost.byProvider.map((p) => _kv(p.provider, fmtCents(p.cents))),
            ],
            if (cost.byAgent.isNotEmpty) ...[
              const SizedBox(height: 16),
              const Text('By agent', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(height: 6),
              ...cost.byAgent.take(5).map((a) => _kv(a.name, fmtCents(a.cents))),
            ],
          ],
        ),
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(k, style: const TextStyle(fontSize: 13)),
            Text(v, style: const TextStyle(fontSize: 13, color: Colors.grey)),
          ],
        ),
      );
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value, this.sub});
  final String label;
  final String value;
  final String? sub;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey)),
        Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        if (sub != null)
          Text(sub!, style: const TextStyle(fontSize: 10, color: Colors.grey)),
      ],
    );
  }
}

class _MostUsedAgentsCard extends StatelessWidget {
  const _MostUsedAgentsCard({required this.analytics});
  final AnalyticsData analytics;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Most-used agents', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            if (analytics.mostUsedAgents.isEmpty)
              const Text('No shared agents used yet.', style: TextStyle(color: Colors.grey, fontSize: 13))
            else
              ...analytics.mostUsedAgents.map((a) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(a.name, style: const TextStyle(fontSize: 13)),
                        Text('${a.messageCount} messages',
                            style: const TextStyle(fontSize: 12, color: Colors.grey)),
                      ],
                    ),
                  )),
          ],
        ),
      ),
    );
  }
}

class _WorkspaceActivityCard extends StatelessWidget {
  const _WorkspaceActivityCard({required this.analytics});
  final AnalyticsData analytics;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Workspace activity', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            if (analytics.workspaceActivity.isEmpty)
              const Text('No workspaces yet.', style: TextStyle(color: Colors.grey, fontSize: 13))
            else
              ...analytics.workspaceActivity.map((w) => Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.grey.withOpacity(0.3)),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          const Icon(Icons.layers_outlined, size: 14),
                          const SizedBox(width: 6),
                          Text(w.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                        ]),
                        const SizedBox(height: 6),
                        Text(
                          '${w.agentCount} agents  ${w.automationCount} automations  ${w.projectCount} projects',
                          style: const TextStyle(fontSize: 11, color: Colors.grey),
                        ),
                      ],
                    ),
                  )),
          ],
        ),
      ),
    );
  }
}

class _RecentActivityCard extends StatelessWidget {
  const _RecentActivityCard({required this.activity});
  final List<RecentActivity> activity;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Text('Recent activity', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
            const SizedBox(height: 8),
            if (activity.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Text('No activity yet.', style: TextStyle(color: Colors.grey)),
              )
            else
              ...activity.map((a) => ListTile(
                    dense: true,
                    title: Text(a.action, style: const TextStyle(fontSize: 13)),
                    subtitle: Text('${a.userName} · ${a.createdAt.toLocal()}'.split('.').first,
                        style: const TextStyle(fontSize: 11)),
                    trailing: Chip(
                      label: Text(a.result, style: const TextStyle(fontSize: 11)),
                      backgroundColor: a.result == 'failure'
                          ? Colors.orange.withOpacity(0.15)
                          : Colors.green.withOpacity(0.15),
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                    ),
                  )),
          ],
        ),
      ),
    );
  }
}
