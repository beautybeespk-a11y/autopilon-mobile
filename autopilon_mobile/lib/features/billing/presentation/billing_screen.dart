import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../dashboard/data/dashboard_models.dart' show CostData;
import '../../organizations/providers/organization_provider.dart';
import '../data/billing_models.dart';
import '../providers/billing_provider.dart';

const _quotaLabels = {
  'maxUsers': 'Team members',
  'maxAgents': 'Agents',
  'maxAutomations': 'Automations',
  'maxIntegrations': 'Integrations',
  'maxAiRequests': 'AI requests this period',
};

class BillingScreen extends ConsumerStatefulWidget {
  const BillingScreen({super.key});
  @override
  ConsumerState<BillingScreen> createState() => _BillingScreenState();
}

class _BillingScreenState extends ConsumerState<BillingScreen> {
  final _couponCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  String _apiKeyProvider = 'anthropic';

  @override
  void dispose() {
    _couponCtrl.dispose();
    _apiKeyCtrl.dispose();
    super.dispose();
  }

  Future<void> _openUrl(String? url) async {
    if (url == null) return;
    final uri = Uri.tryParse(url);
    if (uri != null) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  String _fmtCents(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';

  @override
  Widget build(BuildContext context) {
    final orgState = ref.watch(organizationControllerProvider);
    final activeOrgId = orgState.activeOrgId;

    if (activeOrgId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Billing')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('Billing is per-organization — switch to an organization first.', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final myRole = orgState.organizations.firstWhere((o) => o.id == activeOrgId, orElse: () => orgState.organizations.first).myRole;
    if (myRole != 'owner' && myRole != 'admin') {
      return Scaffold(
        appBar: AppBar(title: const Text('Billing')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('Only an organization owner or admin can manage billing.', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final state = ref.watch(billingControllerProvider);
    final controller = ref.read(billingControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Billing')),
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
                        FilledButton(onPressed: controller.refresh, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: controller.refresh,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (state.dashboard?.subscription != null) _CurrentPlanCard(sub: state.dashboard!.subscription!, fmtCents: _fmtCents),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: state.actionBusy ? null : () async => _openUrl(await controller.openPortal()),
                              child: const Text('Manage billing'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          if (state.dashboard?.subscription?.cancelAtPeriodEnd == true)
                            Expanded(
                              child: OutlinedButton(
                                onPressed: state.actionBusy ? null : controller.resumeSubscription,
                                child: const Text('Resume'),
                              ),
                            )
                          else
                            Expanded(
                              child: OutlinedButton(
                                style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                                onPressed: state.actionBusy ? null : controller.cancelSubscription,
                                child: const Text('Cancel'),
                              ),
                            ),
                        ],
                      ),
                      if (state.actionMessage != null) ...[
                        const SizedBox(height: 8),
                        Text(state.actionMessage!, style: TextStyle(color: Theme.of(context).colorScheme.primary, fontSize: 13)),
                      ],

                      const SizedBox(height: 20),
                      Text('Usage & limits', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      ...state.dashboard!.quotas.map((q) => _QuotaBar(quota: q)),

                      if (state.cost != null) ...[
                        const SizedBox(height: 20),
                        _CostSection(cost: state.cost!, fmtCents: _fmtCents),
                      ],

                      if (state.credits != null) ...[
                        const SizedBox(height: 20),
                        _CreditsSection(credits: state.credits!, fmtCents: _fmtCents),
                      ],

                      const SizedBox(height: 20),
                      Text('Plans', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      ...state.plans.map((p) => _PlanTile(
                            plan: p,
                            current: p.id == state.dashboard?.subscription?.planId,
                            busy: state.actionBusy,
                            onSelect: () async => _openUrl(await controller.startCheckout(p.id)),
                          )),

                      const SizedBox(height: 20),
                      Text('Coupon', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _couponCtrl,
                              decoration: const InputDecoration(hintText: 'Coupon code', isDense: true),
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: state.actionBusy
                                ? null
                                : () {
                                    controller.redeemCoupon(_couponCtrl.text.trim());
                                    _couponCtrl.clear();
                                  },
                            child: const Text('Redeem'),
                          ),
                        ],
                      ),

                      const SizedBox(height: 20),
                      Text('AI billing mode', style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 8),
                      SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(value: 'platform_managed', label: Text('Platform-managed', style: TextStyle(fontSize: 12))),
                          ButtonSegment(value: 'byok', label: Text('Bring your own key', style: TextStyle(fontSize: 12))),
                        ],
                        selected: {state.dashboard?.subscription?.billingMode ?? 'platform_managed'},
                        onSelectionChanged: state.actionBusy ? null : (s) => controller.setBillingMode(s.first),
                      ),

                      if (state.dashboard?.subscription?.billingMode == 'byok') ...[
                        const SizedBox(height: 20),
                        Text('Your API keys', style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 8),
                        ...state.apiKeys.map((k) => Card(
                              child: ListTile(
                                dense: true,
                                title: Text(k.provider),
                                subtitle: Text(k.masked, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                                trailing: IconButton(
                                  icon: const Icon(Icons.delete_outline, size: 18),
                                  onPressed: () => controller.removeApiKey(k.provider),
                                ),
                              ),
                            )),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            DropdownButton<String>(
                              value: _apiKeyProvider,
                              items: const [
                                DropdownMenuItem(value: 'anthropic', child: Text('Anthropic')),
                                DropdownMenuItem(value: 'openai', child: Text('OpenAI')),
                                DropdownMenuItem(value: 'gemini', child: Text('Gemini')),
                              ],
                              onChanged: (v) => setState(() => _apiKeyProvider = v ?? 'anthropic'),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: TextField(
                                controller: _apiKeyCtrl,
                                obscureText: true,
                                decoration: const InputDecoration(hintText: 'API key', isDense: true),
                              ),
                            ),
                            const SizedBox(width: 8),
                            FilledButton(
                              onPressed: state.actionBusy
                                  ? null
                                  : () {
                                      if (_apiKeyCtrl.text.trim().isEmpty) return;
                                      controller.addApiKey(_apiKeyProvider, _apiKeyCtrl.text.trim());
                                      _apiKeyCtrl.clear();
                                    },
                              child: const Text('Save'),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 24),
                    ],
                  ),
                ),
    );
  }
}

class _CurrentPlanCard extends StatelessWidget {
  const _CurrentPlanCard({required this.sub, required this.fmtCents});
  final Subscription sub;
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
                Text(sub.plan?.name ?? sub.planId, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(width: 8),
                if (sub.plan != null)
                  Text('${fmtCents(sub.plan!.monthlyPriceCents)}/mo', style: const TextStyle(color: Colors.grey)),
              ],
            ),
            const SizedBox(height: 4),
            if (sub.trialEndsAt != null)
              Text('Trial ends ${sub.trialEndsAt!.split('T').first}', style: const TextStyle(fontSize: 12, color: Colors.orange)),
            if (sub.cancelAtPeriodEnd)
              Text('Cancels at the end of the current period (${sub.currentPeriodEnd.split('T').first})',
                  style: const TextStyle(fontSize: 12, color: Colors.red)),
          ],
        ),
      ),
    );
  }
}

class _QuotaBar extends StatelessWidget {
  const _QuotaBar({required this.quota});
  final BillingQuota quota;

  @override
  Widget build(BuildContext context) {
    final label = _quotaLabels[quota.type] ?? quota.type;
    final unlimited = quota.limit == null;
    final color = quota.warningLevel != null && quota.warningLevel! >= 100
        ? Colors.red
        : quota.warningLevel != null
            ? Colors.orange
            : Theme.of(context).colorScheme.primary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: const TextStyle(fontSize: 13)),
              Text(unlimited ? '${quota.current} / unlimited' : '${quota.current} / ${quota.limit}',
                  style: const TextStyle(fontSize: 12, color: Colors.grey)),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: unlimited ? 0 : (quota.percentUsed / 100).clamp(0, 1),
              minHeight: 6,
              backgroundColor: Colors.grey.withOpacity(0.15),
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _CostSection extends StatelessWidget {
  const _CostSection({required this.cost, required this.fmtCents});
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
            const Text('Estimated AI cost', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: _kv('Platform-billed', fmtCents(cost.estimatedCostCents))),
                Expanded(child: _kv('BYOK (not billed by us)', fmtCents(cost.byokUsageCents))),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _kv(String k, String v) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(k, style: const TextStyle(fontSize: 11, color: Colors.grey)),
          Text(v, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        ],
      );
}

class _CreditsSection extends StatelessWidget {
  const _CreditsSection({required this.credits, required this.fmtCents});
  final CreditInfo credits;
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
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Account credit', style: TextStyle(fontWeight: FontWeight.bold)),
                Text(fmtCents(credits.balanceCents), style: const TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            if (credits.history.isNotEmpty) ...[
              const SizedBox(height: 10),
              ...credits.history.take(5).map((h) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(child: Text(h.reason ?? 'Credit', style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis)),
                        Text(fmtCents(h.amountCents), style: const TextStyle(fontSize: 12, color: Colors.grey)),
                      ],
                    ),
                  )),
            ],
          ],
        ),
      ),
    );
  }
}

class _PlanTile extends StatelessWidget {
  const _PlanTile({required this.plan, required this.current, required this.busy, required this.onSelect});
  final BillingPlan plan;
  final bool current;
  final bool busy;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: current ? Theme.of(context).colorScheme.primary.withOpacity(0.06) : null,
      child: ListTile(
        title: Text(plan.name, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('\$${(plan.monthlyPriceCents / 100).toStringAsFixed(2)}/mo · ${plan.maxAgents ?? '∞'} agents · ${plan.maxAutomations ?? '∞'} automations'),
        trailing: current
            ? const Chip(label: Text('Current', style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact)
            : plan.isCheckoutable
                ? TextButton(onPressed: busy ? null : onSelect, child: const Text('Select'))
                : const Text('Contact us', style: TextStyle(fontSize: 12, color: Colors.grey)),
      ),
    );
  }
}
