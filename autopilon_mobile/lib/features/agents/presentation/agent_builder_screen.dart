import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../data/agent_skills.dart';
import '../providers/agent_builder_provider.dart';
import '../providers/agent_provider.dart';

const _personalities = ['Professional', 'Friendly', 'Creative', 'Direct', 'Custom'];

class AgentBuilderScreen extends ConsumerStatefulWidget {
  const AgentBuilderScreen({super.key, this.agentId});
  final String? agentId;

  @override
  ConsumerState<AgentBuilderScreen> createState() => _AgentBuilderScreenState();
}

class _AgentBuilderScreenState extends ConsumerState<AgentBuilderScreen> {
  final _nameCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _instructionsCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  bool _seeded = false;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _descCtrl.dispose();
    _instructionsCtrl.dispose();
    _modelCtrl.dispose();
    super.dispose();
  }

  /// Text controllers can't just read from Riverpod state on every rebuild
  /// (that would fight the user's typing), so they're seeded once after the
  /// initial load finishes (relevant in edit mode, where the load is async).
  void _seedControllers(AgentBuilderState state) {
    if (_seeded || state.loading) return;
    _nameCtrl.text = state.name;
    _descCtrl.text = state.description;
    _instructionsCtrl.text = state.instructions;
    _modelCtrl.text = state.aiModel;
    _seeded = true;
  }

  Future<void> _save(AgentBuilderController controller) async {
    final id = await controller.save();
    if (id != null && mounted) {
      ref.read(agentsControllerProvider.notifier).load();
      context.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(agentBuilderControllerProvider(widget.agentId));
    final controller = ref.read(agentBuilderControllerProvider(widget.agentId).notifier);
    _seedControllers(state);

    final isEdit = widget.agentId != null;

    return Scaffold(
      appBar: AppBar(title: Text(isEdit ? 'Edit agent' : 'Agent Builder')),
      body: state.loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  isEdit ? "Update this agent's behavior and enabled skills." : 'Define how your agent behaves and what it can do.',
                  style: const TextStyle(color: Colors.grey),
                ),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        TextField(
                          controller: _nameCtrl,
                          decoration: const InputDecoration(labelText: 'Agent name', hintText: 'e.g. Marketing Assistant'),
                          onChanged: controller.setName,
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _descCtrl,
                          decoration: const InputDecoration(labelText: 'Description', hintText: 'What is this agent for?'),
                          onChanged: controller.setDescription,
                        ),
                        const SizedBox(height: 16),
                        const Text('Personality', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _personalities
                              .map((p) => ChoiceChip(
                                    label: Text(p),
                                    selected: state.personality == p,
                                    onSelected: (_) => controller.setPersonality(p),
                                  ))
                              .toList(),
                        ),
                        const SizedBox(height: 16),
                        TextField(
                          controller: _instructionsCtrl,
                          minLines: 4,
                          maxLines: 8,
                          decoration: const InputDecoration(labelText: 'Instructions', hintText: 'Tell your AI agent how it should behave.'),
                          onChanged: controller.setInstructions,
                        ),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Skills', style: TextStyle(fontWeight: FontWeight.bold)),
                        const Text('Select the capabilities this agent can use.', style: TextStyle(fontSize: 12, color: Colors.grey)),
                        const SizedBox(height: 12),
                        ...builtinSkills.map((s) => _SkillTile(
                              skill: s,
                              selected: state.skillIds.contains(s.id),
                              onTap: () => controller.toggleSkill(s.id),
                            )),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('AI Model', style: TextStyle(fontWeight: FontWeight.bold)),
                        const Text('Choose which AI this agent uses, or leave on the platform default.',
                            style: TextStyle(fontSize: 12, color: Colors.grey)),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<String>(
                          value: state.aiProvider,
                          decoration: const InputDecoration(labelText: 'Provider', isDense: true),
                          items: [
                            const DropdownMenuItem(value: '', child: Text('Platform default')),
                            ...state.providerOptions.map((p) => DropdownMenuItem(
                                  value: p.id,
                                  enabled: p.configured,
                                  child: Text('${p.label}${p.configured ? '' : ' (not configured)'}'),
                                )),
                          ],
                          onChanged: (v) => controller.setAiProvider(v ?? ''),
                        ),
                        if (state.aiProvider.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          TextField(
                            controller: _modelCtrl,
                            decoration: const InputDecoration(
                              labelText: 'Model (optional)',
                              hintText: "Leave blank to use this provider's default model",
                              isDense: true,
                            ),
                            onChanged: controller.setAiModel,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),

                if (controller.manageableOrgs.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Sharing', style: TextStyle(fontWeight: FontWeight.bold)),
                          const Text('Keep this agent personal, or share it with an organization.',
                              style: TextStyle(fontSize: 12, color: Colors.grey)),
                          const SizedBox(height: 12),
                          DropdownButtonFormField<String>(
                            value: state.orgId,
                            decoration: const InputDecoration(labelText: 'Organization', isDense: true),
                            items: [
                              const DropdownMenuItem(value: '', child: Text('Personal (only you)')),
                              ...controller.manageableOrgs.map((o) => DropdownMenuItem(value: o.id, child: Text(o.name))),
                            ],
                            onChanged: (v) => controller.setOrgId(v ?? ''),
                          ),
                          if (state.orgId.isNotEmpty) ...[
                            const SizedBox(height: 12),
                            DropdownButtonFormField<String>(
                              value: state.workspaceId,
                              decoration: const InputDecoration(labelText: 'Workspace (optional)', isDense: true),
                              items: [
                                const DropdownMenuItem(value: '', child: Text('Whole organization')),
                                ...state.orgWorkspaces.map((w) => DropdownMenuItem(value: w.id, child: Text(w.name))),
                              ],
                              onChanged: (v) => controller.setWorkspaceId(v ?? ''),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ],

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
                      child: Text(state.saving ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create agent')),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
              ],
            ),
    );
  }
}

class _SkillTile extends StatelessWidget {
  const _SkillTile({required this.skill, required this.selected, required this.onTap});
  final BuiltinSkill skill;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).colorScheme.primary;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border: Border.all(color: selected ? accent : Colors.grey.withOpacity(0.3)),
          color: selected ? accent.withOpacity(0.05) : null,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: selected ? accent : Colors.grey.withOpacity(0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(skill.icon, size: 18, color: selected ? Colors.white : Colors.grey[700]),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(skill.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  Text(skill.description, style: const TextStyle(fontSize: 11, color: Colors.grey)),
                ],
              ),
            ),
            Icon(selected ? Icons.check_circle : Icons.circle_outlined, size: 20, color: selected ? accent : Colors.grey[400]),
          ],
        ),
      ),
    );
  }
}
