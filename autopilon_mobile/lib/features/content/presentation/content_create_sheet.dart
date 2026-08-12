import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../data/content_models.dart';
import '../providers/content_provider.dart';

const _voices = [
  ('alloy', 'Alloy'), ('echo', 'Echo'), ('fable', 'Fable'), ('onyx', 'Onyx'), ('nova', 'Nova'), ('shimmer', 'Shimmer'),
];

const _sizes = [
  ('1024x1024', 'Square'), ('1536x1024', 'Landscape'), ('1024x1536', 'Portrait'),
];

enum _CreateType { image, copy, voiceover }

void showContentCreateSheet(BuildContext context, WidgetRef ref) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (sheetContext) => const _CreateSheet(),
  );
}

class _CreateSheet extends ConsumerStatefulWidget {
  const _CreateSheet();
  @override
  ConsumerState<_CreateSheet> createState() => _CreateSheetState();
}

class _CreateSheetState extends ConsumerState<_CreateSheet> {
  _CreateType _type = _CreateType.image;

  // Image form
  final _promptCtrl = TextEditingController();
  String _size = _sizes.first.$1;

  // Copy form
  List<CopyType> _copyTypes = [];
  String? _copyContentType;
  final _briefCtrl = TextEditingController();

  // Voiceover form
  final _voiceoverTextCtrl = TextEditingController();
  String _voice = _voices.first.$1;

  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    ref.read(contentRepositoryProvider).listCopyTypes().then((result) {
      if (!mounted) return;
      if (result.isSuccess && result.data != null && result.data!.isNotEmpty) {
        setState(() { _copyTypes = result.data!; _copyContentType = result.data!.first.id; });
      }
    });
  }

  @override
  void dispose() {
    _promptCtrl.dispose();
    _briefCtrl.dispose();
    _voiceoverTextCtrl.dispose();
    super.dispose();
  }

  Future<void> _generate() async {
    setState(() { _busy = true; _error = null; });
    final repo = ref.read(contentRepositoryProvider);
    var success = false;
    if (_type == _CreateType.image) {
      if (_promptCtrl.text.trim().isEmpty) { setState(() => _busy = false); return; }
      final result = await repo.generateImage(prompt: _promptCtrl.text.trim(), size: _size);
      success = result.isSuccess;
      if (!success) _error = result.error;
    } else if (_type == _CreateType.copy) {
      if (_briefCtrl.text.trim().isEmpty || _copyContentType == null) { setState(() => _busy = false); return; }
      final result = await repo.generateCopy(contentType: _copyContentType!, brief: _briefCtrl.text.trim());
      success = result.isSuccess;
      if (!success) _error = result.error;
    } else {
      if (_voiceoverTextCtrl.text.trim().isEmpty) { setState(() => _busy = false); return; }
      final result = await repo.generateVoiceover(text: _voiceoverTextCtrl.text.trim(), voice: _voice);
      success = result.isSuccess;
      if (!success) _error = result.error;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (success) {
      ref.read(contentControllerProvider.notifier).load();
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved to your Content Library.')));
    } else {
      setState(() {}); // surface _error
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(left: 16, right: 16, top: 16, bottom: MediaQuery.of(context).viewInsets.bottom + 16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Create', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: [
                  ChoiceChip(label: const Text('Image'), avatar: const Icon(Icons.image_outlined, size: 16), selected: _type == _CreateType.image, onSelected: (_) => setState(() => _type = _CreateType.image)),
                  ChoiceChip(label: const Text('Copywriter'), avatar: const Icon(Icons.edit_note_outlined, size: 16), selected: _type == _CreateType.copy, onSelected: (_) => setState(() => _type = _CreateType.copy)),
                  ChoiceChip(label: const Text('Voiceover'), avatar: const Icon(Icons.mic_none_outlined, size: 16), selected: _type == _CreateType.voiceover, onSelected: (_) => setState(() => _type = _CreateType.voiceover)),
                ],
              ),
              const SizedBox(height: 16),
              if (_type == _CreateType.image) _buildImageForm(),
              if (_type == _CreateType.copy) _buildCopyForm(),
              if (_type == _CreateType.voiceover) _buildVoiceoverForm(),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 13)),
              ],
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _busy ? null : _generate,
                  icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.auto_awesome, size: 18),
                  label: const Text('Generate'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildImageForm() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _promptCtrl,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Prompt', hintText: 'A minimalist product shot on a wooden table…', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            value: _size,
            decoration: const InputDecoration(labelText: 'Size', border: OutlineInputBorder()),
            items: _sizes.map((s) => DropdownMenuItem(value: s.$1, child: Text(s.$2))).toList(),
            onChanged: (v) => setState(() => _size = v ?? _size),
          ),
        ],
      );

  Widget _buildCopyForm() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_copyTypes.isEmpty)
            const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
          else
            DropdownButtonFormField<String>(
              value: _copyContentType,
              decoration: const InputDecoration(labelText: 'What to write', border: OutlineInputBorder()),
              items: _copyTypes.map((t) => DropdownMenuItem(value: t.id, child: Text(t.label))).toList(),
              onChanged: (v) => setState(() => _copyContentType = v),
            ),
          const SizedBox(height: 12),
          TextField(
            controller: _briefCtrl,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Brief', hintText: 'What is this for?', border: OutlineInputBorder()),
          ),
        ],
      );

  Widget _buildVoiceoverForm() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _voiceoverTextCtrl,
            maxLines: 4,
            maxLength: 4000,
            decoration: const InputDecoration(labelText: 'Script', hintText: 'What should the voiceover say?', border: OutlineInputBorder()),
          ),
          DropdownButtonFormField<String>(
            value: _voice,
            decoration: const InputDecoration(labelText: 'Voice', border: OutlineInputBorder()),
            items: _voices.map((v) => DropdownMenuItem(value: v.$1, child: Text(v.$2))).toList(),
            onChanged: (v) => setState(() => _voice = v ?? _voice),
          ),
        ],
      );
}
