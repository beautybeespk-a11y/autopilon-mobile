import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/api/api_client.dart';
import '../data/automation_models.dart';
import '../providers/automation_builder_provider.dart';

const _triggerTypes = [
  ('manual', 'Manual — run it yourself'),
  ('schedule', 'Schedule — runs automatically'),
  ('whatsapp_message', 'WhatsApp message received'),
  ('meta_ads_event', 'Meta Ads change (campaign created/updated/paused/resumed)'),
  ('webhook', 'External webhook'),
  ('task_created', 'Task created'),
  ('task_completed', 'Task completed'),
  ('automation_completed', 'Another workflow completed'),
  ('automation_failed', 'Another workflow failed'),
  ('ai_chat_request', 'AI chat request (not yet auto-firing)'),
  ('knowledge_update', 'Knowledge update (not yet auto-firing)'),
  ('task_due', 'Task due (not yet auto-firing)'),
];

const _frequencies = ['every_minute', 'hourly', 'daily', 'weekly', 'monthly', 'cron'];
const _stepTypes = ['action', 'condition', 'ai_decision', 'approval', 'delay', 'loop', 'end'];
const _conditionOps = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists', 'empty'];

class AutomationBuilderScreen extends ConsumerStatefulWidget {
  const AutomationBuilderScreen({super.key, this.automationId});
  final String? automationId;

  @override
  ConsumerState<AutomationBuilderScreen> createState() => _AutomationBuilderScreenState();
}

class _AutomationBuilderScreenState extends ConsumerState<AutomationBuilderScreen> {
  final _nameCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  bool _seeded = false;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  void _seedControllers(AutomationBuilderState state) {
    if (_seeded || state.loading) return;
    _nameCtrl.text = state.name;
    _descCtrl.text = state.description;
    _seeded = true;
  }

  Future<void> _save(AutomationBuilderController controller) async {
    final id = await controller.save();
    if (id != null && mounted) context.pop();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(automationBuilderControllerProvider(widget.automationId));
    final controller = ref.read(automationBuilderControllerProvider(widget.automationId).notifier);
    _seedControllers(state);
    final isEdit = widget.automationId != null;

    return Scaffold(
      appBar: AppBar(title: Text(isEdit ? 'Edit workflow' : 'New workflow')),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Text("Saved as a draft — activate it from the list when you're ready.", style: TextStyle(color: Colors.grey)),
                const SizedBox(height: 16),

                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        TextField(
                          controller: _nameCtrl,
                          decoration: const InputDecoration(labelText: 'Name', hintText: 'e.g. Morning Business Report'),
                          onChanged: controller.setName,
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _descCtrl,
                          minLines: 2,
                          maxLines: 4,
                          decoration: const InputDecoration(labelText: 'Description'),
                          onChanged: controller.setDescription,
                        ),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<String>(
                          value: state.agentId.isEmpty ? null : state.agentId,
                          decoration: const InputDecoration(labelText: 'Agent', isDense: true),
                          items: [
                            const DropdownMenuItem(value: '', child: Text('No agent (steps needing tools will fail)')),
                            ...state.agents.map((a) => DropdownMenuItem(value: a.id, child: Text(a.name))),
                          ],
                          onChanged: (v) => controller.setAgentId(v ?? ''),
                        ),
                        const Text('Determines which skills/tools this workflow can use.', style: TextStyle(fontSize: 11, color: Colors.grey)),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<String>(
                          value: state.triggerType,
                          decoration: const InputDecoration(labelText: 'Trigger', isDense: true),
                          isExpanded: true,
                          items: _triggerTypes
                              .map((t) => DropdownMenuItem(value: t.$1, child: Text(t.$2, overflow: TextOverflow.ellipsis)))
                              .toList(),
                          onChanged: (v) => controller.setTriggerType(v ?? 'manual'),
                        ),
                        _TriggerConfig(automationId: widget.automationId, state: state, controller: controller),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Steps', style: Theme.of(context).textTheme.titleMedium),
                    TextButton.icon(onPressed: controller.addStep, icon: const Icon(Icons.add, size: 18), label: const Text('Add step')),
                  ],
                ),
                const SizedBox(height: 8),
                if (state.steps.isEmpty) const Text('No steps yet — add one above.', style: TextStyle(color: Colors.grey, fontSize: 13)),
                for (var i = 0; i < state.steps.length; i++)
                  _StepEditor(
                    key: ObjectKey(state.steps[i]),
                    step: state.steps[i],
                    index: i,
                    controller: controller,
                    isFirst: i == 0,
                    isLast: i == state.steps.length - 1,
                  ),

                if (state.error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: Colors.red.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                    child: Text(state.error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
                  ),
                ],

                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    OutlinedButton(onPressed: () => context.pop(), child: const Text('Cancel')),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: state.saving || state.name.trim().isEmpty ? null : () => _save(controller),
                      child: Text(state.saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create workflow')),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
              ],
            ),
    );
  }
}

class _TriggerConfig extends StatelessWidget {
  const _TriggerConfig({required this.automationId, required this.state, required this.controller});
  final String? automationId;
  final AutomationBuilderState state;
  final AutomationBuilderController controller;

  @override
  Widget build(BuildContext context) {
    final config = state.triggerConfig;
    switch (state.triggerType) {
      case 'schedule':
        final frequency = config['frequency'] ?? 'daily';
        return Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DropdownButtonFormField<String>(
                value: frequency,
                decoration: const InputDecoration(labelText: 'Frequency', isDense: true),
                items: _frequencies.map((f) => DropdownMenuItem(value: f, child: Text(f))).toList(),
                onChanged: (v) => controller.setScheduleFrequency(v ?? 'daily'),
              ),
              const SizedBox(height: 10),
              if (frequency == 'cron')
                TextFormField(
                  initialValue: config['cron'] ?? '',
                  decoration: const InputDecoration(labelText: 'Cron expression', hintText: '0 9 * * *', isDense: true),
                  onChanged: controller.setScheduleCron,
                )
              else
                TextFormField(
                  initialValue: '${config['hour'] ?? 9}',
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Hour (24h)', isDense: true),
                  onChanged: (v) => controller.setScheduleHour(int.tryParse(v) ?? 9),
                ),
            ],
          ),
        );
      case 'whatsapp_message':
        return Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
          child: TextFormField(
            initialValue: config['keyword'] ?? '',
            decoration: const InputDecoration(labelText: 'Only run if the message contains (optional)', hintText: 'e.g. price', isDense: true),
            onChanged: controller.setWhatsappKeyword,
          ),
        );
      case 'meta_ads_event':
        return Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
          child: DropdownButtonFormField<String>(
            value: config['eventSubtype'] ?? '',
            decoration: const InputDecoration(labelText: 'Only run for this change (optional)', isDense: true),
            items: const [
              DropdownMenuItem(value: '', child: Text('Any change')),
              DropdownMenuItem(value: 'campaign_created', child: Text('Campaign created')),
              DropdownMenuItem(value: 'campaign_updated', child: Text('Campaign updated')),
              DropdownMenuItem(value: 'campaign_paused', child: Text('Campaign paused')),
              DropdownMenuItem(value: 'campaign_resumed', child: Text('Campaign resumed')),
            ],
            onChanged: (v) => controller.setMetaAdsEventSubtype(v ?? ''),
          ),
        );
      case 'webhook':
        final secret = config['secret'];
        return Container(
          margin: const EdgeInsets.only(top: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.grey.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
          child: automationId != null && secret != null
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Send a POST request here to trigger this workflow:', style: TextStyle(color: Colors.grey, fontSize: 12)),
                    const SizedBox(height: 4),
                    SelectableText('${ApiClient.baseUrl}/triggers/webhook/$automationId',
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
                    const SizedBox(height: 8),
                    const Text('With this header (keep it secret):', style: TextStyle(color: Colors.grey, fontSize: 12)),
                    const SizedBox(height: 4),
                    SelectableText('x-webhook-secret: $secret', style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
                  ],
                )
              : const Text('Save this workflow once to generate its webhook URL and secret.', style: TextStyle(color: Colors.grey, fontSize: 12)),
        );
      default:
        return const SizedBox.shrink();
    }
  }
}

class _StepEditor extends StatefulWidget {
  const _StepEditor({
    super.key,
    required this.step,
    required this.index,
    required this.controller,
    required this.isFirst,
    required this.isLast,
  });
  final AutomationStep step;
  final int index;
  final AutomationBuilderController controller;
  final bool isFirst;
  final bool isLast;

  @override
  State<_StepEditor> createState() => _StepEditorState();
}

class _StepEditorState extends State<_StepEditor> {
  late final TextEditingController _toolNameCtrl;
  late final TextEditingController _parametersCtrl;
  late final TextEditingController _resultVarCtrl;
  late final TextEditingController _fieldCtrl;
  late final TextEditingController _valueCtrl;
  late final TextEditingController _onFalseCtrl;
  late final TextEditingController _questionCtrl;
  late final TextEditingController _optionsCtrl;
  late final TextEditingController _reasonCtrl;
  late final TextEditingController _secondsCtrl;
  late final TextEditingController _overVarCtrl;
  late final TextEditingController _itemVarCtrl;
  bool _paramsInvalid = false;

  @override
  void initState() {
    super.initState();
    final c = widget.step.config;
    _toolNameCtrl = TextEditingController(text: c['toolName'] ?? '');
    _parametersCtrl = TextEditingController(text: const JsonEncoder.withIndent('  ').convert(c['parameters'] ?? {}));
    _resultVarCtrl = TextEditingController(text: c['resultVariable'] ?? '');
    _fieldCtrl = TextEditingController(text: c['field'] ?? '');
    _valueCtrl = TextEditingController(text: c['value']?.toString() ?? '');
    _onFalseCtrl = TextEditingController(text: c['onFalse']?.toString() ?? '');
    _questionCtrl = TextEditingController(text: c['question'] ?? '');
    _optionsCtrl = TextEditingController(text: (c['options'] as List?)?.join(', ') ?? '');
    _reasonCtrl = TextEditingController(text: c['reason'] ?? '');
    _secondsCtrl = TextEditingController(text: c['seconds']?.toString() ?? '');
    _overVarCtrl = TextEditingController(text: c['overVariable'] ?? '');
    _itemVarCtrl = TextEditingController(text: c['itemVariable'] ?? 'item');
  }

  @override
  void dispose() {
    _toolNameCtrl.dispose();
    _parametersCtrl.dispose();
    _resultVarCtrl.dispose();
    _fieldCtrl.dispose();
    _valueCtrl.dispose();
    _onFalseCtrl.dispose();
    _questionCtrl.dispose();
    _optionsCtrl.dispose();
    _reasonCtrl.dispose();
    _secondsCtrl.dispose();
    _overVarCtrl.dispose();
    _itemVarCtrl.dispose();
    super.dispose();
  }

  void _patch(Map<String, dynamic> patch) => widget.controller.updateStepConfig(widget.index, patch);

  void _patchCondition({String? field, String? op, String? value}) {
    final config = widget.step.config;
    final f = field ?? config['field'] ?? '';
    final o = op ?? config['op'] ?? 'equals';
    final v = value ?? config['value'] ?? '';
    _patch({
      'field': f,
      'op': o,
      'value': v,
      'groups': [
        [
          {'field': f, 'op': o, 'value': v}
        ]
      ],
    });
  }

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
                Expanded(
                  child: DropdownButtonFormField<String>(
                    value: widget.step.type,
                    isDense: true,
                    decoration: const InputDecoration(isDense: true, border: InputBorder.none),
                    items: _stepTypes.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                    onChanged: (v) => widget.controller.updateStepType(widget.index, v ?? 'action'),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_upward, size: 16),
                  onPressed: widget.isFirst ? null : () => widget.controller.moveStep(widget.index, -1),
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_downward, size: 16),
                  onPressed: widget.isLast ? null : () => widget.controller.moveStep(widget.index, 1),
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline, size: 16, color: Colors.red),
                  onPressed: () => widget.controller.removeStep(widget.index),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ..._fieldsForType(),
          ],
        ),
      ),
    );
  }

  List<Widget> _fieldsForType() {
    switch (widget.step.type) {
      case 'action':
        return [
          TextField(
            controller: _toolNameCtrl,
            decoration: const InputDecoration(labelText: 'Tool name', hintText: 'e.g. create_task, list_campaigns, web_search', isDense: true),
            onChanged: (v) => _patch({'toolName': v}),
          ),
          const SizedBox(height: 10),
          Text('Parameters (JSON, supports {{variableName}})', style: TextStyle(fontSize: 12, color: Colors.grey[700])),
          const SizedBox(height: 4),
          TextField(
            controller: _parametersCtrl,
            minLines: 3,
            maxLines: 6,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            decoration: InputDecoration(
              isDense: true,
              border: OutlineInputBorder(borderSide: BorderSide(color: _paramsInvalid ? Colors.amber : Colors.grey.withOpacity(0.4))),
            ),
            onChanged: (v) {
              try {
                final parsed = jsonDecode(v);
                setState(() => _paramsInvalid = false);
                _patch({'parameters': parsed});
              } catch (_) {
                setState(() => _paramsInvalid = true);
              }
            },
          ),
          if (_paramsInvalid) const Text('Not valid JSON yet — keep typing.', style: TextStyle(fontSize: 11, color: Colors.amber)),
          const SizedBox(height: 10),
          TextField(
            controller: _resultVarCtrl,
            decoration: const InputDecoration(labelText: 'Save result as variable', hintText: 'e.g. campaigns', isDense: true),
            onChanged: (v) => _patch({'resultVariable': v}),
          ),
        ];
      case 'condition':
        return [
          const Text('If false, jump to step number (0-indexed) — leave blank to just continue.', style: TextStyle(fontSize: 11, color: Colors.grey)),
          const SizedBox(height: 8),
          TextField(
            controller: _fieldCtrl,
            decoration: const InputDecoration(labelText: 'Field (e.g. {{campaigns.length}})', isDense: true),
            onChanged: (v) => _patchCondition(field: v),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  value: widget.step.config['op'] ?? 'equals',
                  decoration: const InputDecoration(labelText: 'Operator', isDense: true),
                  items: _conditionOps.map((o) => DropdownMenuItem(value: o, child: Text(o))).toList(),
                  onChanged: (v) => _patchCondition(op: v),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: TextField(
                  controller: _valueCtrl,
                  decoration: const InputDecoration(labelText: 'Value', isDense: true),
                  onChanged: (v) => _patchCondition(value: v),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _onFalseCtrl,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'If false, jump to step #', isDense: true),
            onChanged: (v) => _patch({'onFalse': v.isEmpty ? null : int.tryParse(v)}),
          ),
        ];
      case 'ai_decision':
        return [
          TextField(
            controller: _questionCtrl,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Question for the AI', isDense: true),
            onChanged: (v) => _patch({'question': v}),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _optionsCtrl,
            decoration: const InputDecoration(labelText: 'Options (comma-separated, optional)', isDense: true),
            onChanged: (v) => _patch({'options': v.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList()}),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _resultVarCtrl,
            decoration: const InputDecoration(labelText: 'Save result as variable', hintText: 'e.g. aiDecision', isDense: true),
            onChanged: (v) => _patch({'resultVariable': v}),
          ),
        ];
      case 'approval':
        return [
          TextField(
            controller: _reasonCtrl,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'What should the approval message say?', isDense: true),
            onChanged: (v) => _patch({'reason': v}),
          ),
        ];
      case 'delay':
        return [
          TextField(
            controller: _secondsCtrl,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Seconds to wait (max 60 in this version)', isDense: true),
            onChanged: (v) => _patch({'seconds': int.tryParse(v) ?? 0}),
          ),
        ];
      case 'loop':
        return [
          TextField(
            controller: _overVarCtrl,
            decoration: const InputDecoration(labelText: 'Variable to loop over (e.g. {{campaigns}})', isDense: true),
            onChanged: (v) => _patch({'overVariable': v}),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _itemVarCtrl,
            decoration: const InputDecoration(labelText: 'Name for each item', isDense: true),
            onChanged: (v) => _patch({'itemVariable': v}),
          ),
          const SizedBox(height: 8),
          const Text(
            "Nested steps aren't editable here yet — set them via the JSON parameters of an action step, or edit the automation's steps directly through the API for complex loops.",
            style: TextStyle(fontSize: 11, color: Colors.grey),
          ),
        ];
      case 'end':
        return [const Text('Ends the workflow here.', style: TextStyle(fontSize: 12, color: Colors.grey))];
      default:
        return const [];
    }
  }
}
