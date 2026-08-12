import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../../voice/presentation/voice_speak_button.dart';
import '../../voice/providers/voice_recorder_provider.dart';
import '../data/chat_models.dart';
import '../providers/chat_provider.dart';

const _suggested = [
  'Draft a launch plan for a new product',
  'Summarize the key risks in a project',
  'Brainstorm names for an AI agent',
];

class ChatScreen extends ConsumerWidget {
  const ChatScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(chatControllerProvider);
    final controller = ref.read(chatControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Chat'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_comment_outlined),
            tooltip: 'New conversation',
            onPressed: controller.newConversation,
          ),
          Builder(
            builder: (context) => IconButton(
              icon: const Icon(Icons.menu),
              tooltip: 'Conversations',
              onPressed: () => Scaffold.of(context).openEndDrawer(),
            ),
          ),
        ],
      ),
      endDrawer: _ConversationDrawer(state: state, controller: controller),
      body: Column(
        children: [
          if (state.providerError != null)
            Container(
              margin: const EdgeInsets.all(12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.amber.withOpacity(0.1),
                border: Border.all(color: Colors.amber.withOpacity(0.4)),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, size: 18, color: Colors.amber),
                  const SizedBox(width: 8),
                  Expanded(child: Text('AI provider not configured — ${state.providerError}')),
                ],
              ),
            ),
          Expanded(
            child: state.messages.isEmpty && !state.sending
                ? _EmptyChat(agentSelected: state.agentId?.isNotEmpty == true, onSuggestion: controller.send)
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      ...state.messages.map((m) => _MessageBubble(
                            message: m,
                            controller: controller,
                            autoPlay: state.justRepliedMessageId == m.id,
                          )),
                      if (state.sending) const _TypingIndicator(),
                    ],
                  ),
          ),
          _Composer(state: state, controller: controller),
        ],
      ),
    );
  }
}

class _EmptyChat extends StatelessWidget {
  const _EmptyChat({required this.agentSelected, required this.onSuggestion});
  final bool agentSelected;
  final void Function(String) onSuggestion;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                gradient: LinearGradient(colors: [
                  Theme.of(context).colorScheme.primary,
                  Theme.of(context).colorScheme.secondary,
                ]),
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Icon(Icons.auto_awesome, color: Colors.white),
            ),
            const SizedBox(height: 16),
            Text('Your AI workspace starts here.', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            const Text('Ask questions, create plans, analyze information, and get things done.',
                textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
            if (agentSelected) ...[
              const SizedBox(height: 8),
              const Text('Try: "Create a task called Launch skincare campaign" or "Remember that I sell skincare products."',
                  textAlign: TextAlign.center, style: TextStyle(color: Colors.grey, fontSize: 12)),
            ],
            const SizedBox(height: 20),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: _suggested
                  .map((s) => OutlinedButton(onPressed: () => onSuggestion(s), child: Text(s)))
                  .toList(),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.controller, this.autoPlay = false});
  final ChatMessage message;
  final ChatController controller;
  final bool autoPlay;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == 'user';
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Align(
            alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
            child: Container(
              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.surfaceVariant,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                message.content,
                style: TextStyle(color: isUser ? Colors.white : Theme.of(context).colorScheme.onSurface),
              ),
            ),
          ),
          if (!isUser && message.trace != null && message.trace!.isNotEmpty) _ToolTrace(steps: message.trace!),
          if (!isUser && message.content.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: VoiceSpeakButton(
                text: message.content,
                autoPlay: autoPlay,
                onAutoPlayed: controller.clearJustReplied,
              ),
            ),
          if (!isUser && message.confirmation != null && message.confirmation!.resolution == null)
            _ConfirmationCard(
              confirmation: message.confirmation!,
              onResolve: (approved) => controller.resolveConfirmation(message.id, approved),
            ),
        ],
      ),
    );
  }
}

/// Renders the tool-call trace for an assistant message. The web client's
/// ToolActivity component wasn't part of what I could pull, so this is a
/// simple generic renderer of the raw trace steps — flag if it needs richer
/// formatting to match ToolActivity.jsx exactly.
class _ToolTrace extends StatelessWidget {
  const _ToolTrace({required this.steps});
  final List<dynamic> steps;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.grey.withOpacity(0.08),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: steps.map((s) {
          final text = s is Map ? (s['tool'] ?? s['name'] ?? s.toString()) : s.toString();
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.bolt, size: 12, color: Colors.grey),
                const SizedBox(width: 6),
                Expanded(child: Text('$text', style: const TextStyle(fontSize: 11, color: Colors.grey))),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _ConfirmationCard extends StatefulWidget {
  const _ConfirmationCard({required this.confirmation, required this.onResolve});
  final Confirmation confirmation;
  final void Function(bool approved) onResolve;

  @override
  State<_ConfirmationCard> createState() => _ConfirmationCardState();
}

class _ConfirmationCardState extends State<_ConfirmationCard> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final del = isDeleteAction(widget.confirmation.toolName);
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.amber.withOpacity(0.3)),
        color: Colors.amber.withOpacity(0.08),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Waiting for your approval to continue.', style: TextStyle(color: Colors.amber[800], fontSize: 13)),
          const SizedBox(height: 8),
          Row(
            children: [
              FilledButton(
                onPressed: _busy ? null : () => _resolve(true),
                child: Text(del ? 'Delete' : 'Approve'),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: _busy ? null : () => _resolve(false),
                child: Text(del ? 'Cancel' : 'Reject'),
              ),
              if (_busy) ...[
                const SizedBox(width: 8),
                const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _resolve(bool approved) async {
    setState(() => _busy = true);
    widget.onResolve(approved);
    if (mounted) setState(() => _busy = false);
  }
}

class _TypingIndicator extends StatelessWidget {
  const _TypingIndicator();
  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceVariant,
          borderRadius: BorderRadius.circular(16),
        ),
        child: const SizedBox(width: 30, height: 8, child: LinearProgressIndicator()),
      ),
    );
  }
}

class _Composer extends ConsumerStatefulWidget {
  const _Composer({required this.state, required this.controller});
  final ChatState state;
  final ChatController controller;
  @override
  ConsumerState<_Composer> createState() => _ComposerState();
}

class _ComposerState extends ConsumerState<_Composer> {
  final _inputCtrl = TextEditingController();

  @override
  void dispose() {
    _inputCtrl.dispose();
    super.dispose();
  }

  void _send() {
    final text = _inputCtrl.text;
    if (text.trim().isEmpty && widget.state.attachment == null) return;
    widget.controller.send(text);
    _inputCtrl.clear();
  }

  void _showAttachMenu(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Photo Library'),
              onTap: () {
                Navigator.pop(sheetContext);
                widget.controller.pickImage(ImageSource.gallery);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Camera'),
              onTap: () {
                Navigator.pop(sheetContext);
                widget.controller.pickImage(ImageSource.camera);
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final attachment = widget.state.attachment;
    final uploading = widget.state.attachUploading;
    final attachError = widget.state.attachError;
    final previewPath = widget.state.attachmentPreviewPath;

    final voiceState = ref.watch(voiceRecorderControllerProvider);
    final voiceController = ref.read(voiceRecorderControllerProvider.notifier);
    ref.listen<VoiceRecorderState>(voiceRecorderControllerProvider, (previous, next) {
      if (next.transcript == null) return;
      setState(() {
        _inputCtrl.text = _inputCtrl.text.trim().isEmpty ? next.transcript! : '${_inputCtrl.text} ${next.transcript}';
        _inputCtrl.selection = TextSelection.collapsed(offset: _inputCtrl.text.length);
      });
      voiceController.clearTranscript();
    });

    return SafeArea(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: Theme.of(context).dividerColor))),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (attachment != null || uploading || attachError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    if (attachment?.isImage == true && previewPath != null)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(6),
                        child: Image.file(File(previewPath), width: 32, height: 32, fit: BoxFit.cover),
                      )
                    else
                      const Icon(Icons.insert_drive_file_outlined, size: 18),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        uploading ? 'Uploading…' : (attachError ?? attachment?.title ?? ''),
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: attachError != null ? Colors.red : null, fontSize: 13),
                      ),
                    ),
                    if (!uploading)
                      IconButton(
                        icon: const Icon(Icons.close, size: 16),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(),
                        onPressed: widget.controller.clearAttachment,
                      ),
                  ],
                ),
              ),
            if (voiceState.status == VoiceRecorderStatus.error && voiceState.error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded, size: 16, color: Colors.amber),
                    const SizedBox(width: 6),
                    Expanded(child: Text(voiceState.error!, style: const TextStyle(fontSize: 12, color: Colors.amber))),
                    IconButton(
                      icon: const Icon(Icons.close, size: 14),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(),
                      onPressed: voiceController.dismissError,
                    ),
                  ],
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                IconButton(
                  icon: const Icon(Icons.attach_file),
                  tooltip: 'Attach a photo',
                  onPressed: uploading ? null : () => _showAttachMenu(context),
                ),
                if (voiceState.status == VoiceRecorderStatus.recording) ...[
                  Container(
                    margin: const EdgeInsets.only(right: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    decoration: BoxDecoration(color: Colors.red.withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(width: 8, height: 8, decoration: const BoxDecoration(color: Colors.red, shape: BoxShape.circle)),
                        const SizedBox(width: 6),
                        Text(
                          '${(voiceState.elapsedSeconds ~/ 60).toString().padLeft(2, '0')}:${(voiceState.elapsedSeconds % 60).toString().padLeft(2, '0')}',
                          style: const TextStyle(color: Colors.red, fontSize: 12, fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                  IconButton(icon: const Icon(Icons.close, size: 18), tooltip: 'Cancel', onPressed: voiceController.cancel),
                  IconButton(
                    icon: const Icon(Icons.stop_circle, color: Colors.red),
                    tooltip: 'Stop and transcribe',
                    onPressed: () => voiceController.stopAndTranscribe(
                      agentId: widget.state.agentId?.isNotEmpty == true ? widget.state.agentId : null,
                      conversationId: widget.state.activeConversationId,
                    ),
                  ),
                ] else if (voiceState.status == VoiceRecorderStatus.transcribing)
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                  )
                else
                  IconButton(
                    icon: const Icon(Icons.mic_none),
                    tooltip: 'Voice input',
                    onPressed: voiceController.start,
                  ),
                Expanded(
                  child: TextField(
                    controller: _inputCtrl,
                    minLines: 1,
                    maxLines: 5,
                    decoration: InputDecoration(
                      hintText: attachment != null ? 'Ask something about this file (optional)…' : 'Message your assistant…',
                      border: InputBorder.none,
                    ),
                    onSubmitted: (_) => _send(),
                  ),
                ),
                IconButton(
                  icon: widget.state.sending ? const Icon(Icons.stop) : const Icon(Icons.send),
                  onPressed: widget.state.sending ? null : _send,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ConversationDrawer extends StatelessWidget {
  const _ConversationDrawer({required this.state, required this.controller});
  final ChatState state;
  final ChatController controller;

  @override
  Widget build(BuildContext context) {
    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: FilledButton.icon(
                onPressed: () {
                  controller.newConversation();
                  Navigator.pop(context);
                },
                icon: const Icon(Icons.add),
                label: const Text('New conversation'),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: DropdownButtonFormField<String>(
                value: state.agentId?.isNotEmpty == true ? state.agentId : null,
                decoration: const InputDecoration(labelText: 'Agent', isDense: true),
                items: [
                  const DropdownMenuItem(value: null, child: Text('Plain chat (no agent, no tools)')),
                  ...state.agents.map((a) => DropdownMenuItem(value: a.id, child: Text(a.name))),
                ],
                onChanged: controller.setAgentId,
              ),
            ),
            const Divider(height: 24),
            Expanded(
              child: state.conversations.isEmpty
                  ? const Center(child: Text('No conversations yet.', style: TextStyle(color: Colors.grey)))
                  : ListView.builder(
                      itemCount: state.conversations.length,
                      itemBuilder: (context, i) {
                        final c = state.conversations[i];
                        final active = state.activeConversationId == c.id;
                        return ListTile(
                          title: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                          selected: active,
                          selectedTileColor: Theme.of(context).colorScheme.primary.withOpacity(0.08),
                          onTap: () {
                            controller.openConversation(c.id);
                            Navigator.pop(context);
                          },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
