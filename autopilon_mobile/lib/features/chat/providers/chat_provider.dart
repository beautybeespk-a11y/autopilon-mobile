import 'dart:async';
import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../../auth/providers/auth_provider.dart';
import '../../voice/providers/voice_settings_provider.dart';
import '../data/chat_models.dart';
import '../data/chat_repository.dart';

final chatRepositoryProvider = Provider<ChatRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return ChatRepository(apiClientAsync.requireValue);
});

class ChatState {
  final List<Conversation> conversations;
  final List<ChatAgent> agents;
  final String? agentId; // null/"" = plain chat, no agent, no tools
  final String? activeConversationId;
  final List<ChatMessage> messages;
  final bool sending;
  final String? providerError;
  final UploadedAttachment? attachment;
  final String? attachmentPreviewPath; // local picked-file path, for an instant thumbnail
  final bool attachUploading;
  final String? attachError;
  final String? justRepliedMessageId; // triggers exactly one autoplay, for the reply that just arrived

  const ChatState({
    this.conversations = const [],
    this.agents = const [],
    this.agentId,
    this.activeConversationId,
    this.messages = const [],
    this.sending = false,
    this.providerError,
    this.attachment,
    this.attachmentPreviewPath,
    this.attachUploading = false,
    this.attachError,
    this.justRepliedMessageId,
  });

  ChatState copyWith({
    List<Conversation>? conversations,
    List<ChatAgent>? agents,
    String? agentId,
    String? activeConversationId,
    bool clearActiveConversation = false,
    List<ChatMessage>? messages,
    bool? sending,
    String? providerError,
    bool clearProviderError = false,
    UploadedAttachment? attachment,
    String? attachmentPreviewPath,
    bool clearAttachment = false,
    bool? attachUploading,
    String? attachError,
    bool clearAttachError = false,
    String? justRepliedMessageId,
    bool clearJustReplied = false,
  }) =>
      ChatState(
        conversations: conversations ?? this.conversations,
        agents: agents ?? this.agents,
        agentId: agentId ?? this.agentId,
        activeConversationId: clearActiveConversation ? null : (activeConversationId ?? this.activeConversationId),
        messages: messages ?? this.messages,
        sending: sending ?? this.sending,
        providerError: clearProviderError ? null : (providerError ?? this.providerError),
        attachment: clearAttachment ? null : (attachment ?? this.attachment),
        attachmentPreviewPath: clearAttachment ? null : (attachmentPreviewPath ?? this.attachmentPreviewPath),
        attachUploading: attachUploading ?? this.attachUploading,
        attachError: clearAttachError ? null : (attachError ?? this.attachError),
        justRepliedMessageId: clearJustReplied ? null : (justRepliedMessageId ?? this.justRepliedMessageId),
      );
}

class ChatController extends StateNotifier<ChatState> {
  ChatController(this._ref) : super(const ChatState()) {
    _init();
  }
  final Ref _ref;

  Future<void> _init() async {
    await loadConversations();
    final repo = _ref.read(chatRepositoryProvider);
    final result = await repo.agents();
    if (result.isSuccess) {
      final list = result.data ?? [];
      state = state.copyWith(
        agents: list,
        // Default to the user's first agent so tools are available out of
        // the box, rather than silently landing on plain-chat/no-tools.
        agentId: (state.agentId == null || state.agentId!.isEmpty) && list.isNotEmpty ? list.first.id : state.agentId,
      );
    }
  }

  Future<void> loadConversations() async {
    final repo = _ref.read(chatRepositoryProvider);
    final result = await repo.conversations();
    if (result.isSuccess) {
      state = state.copyWith(conversations: result.data ?? []);
    }
  }

  void setAgentId(String? id) => state = state.copyWith(agentId: id ?? '');

  void newConversation() {
    state = state.copyWith(clearActiveConversation: true, messages: [], clearAttachment: true, clearAttachError: true);
  }

  final _picker = ImagePicker();

  /// Mirrors onPickFile() in Chat.jsx, scoped to photos (the mobile attach
  /// button offers gallery + camera, not a generic file picker) — uploads
  /// immediately so the item id is ready by the time the user hits send.
  Future<void> pickImage(ImageSource source) async {
    final picked = await _picker.pickImage(source: source, imageQuality: 85);
    if (picked == null) return;
    state = state.copyWith(attachUploading: true, clearAttachError: true);
    final repo = _ref.read(chatRepositoryProvider);
    final result = await repo.uploadAttachment(File(picked.path));
    if (result.isSuccess && result.data != null) {
      state = state.copyWith(attachment: result.data, attachmentPreviewPath: picked.path, attachUploading: false);
    } else {
      state = state.copyWith(attachUploading: false, attachError: result.error ?? 'Upload failed.');
    }
  }

  void clearAttachment() => state = state.copyWith(clearAttachment: true, clearAttachError: true);

  void clearJustReplied() => state = state.copyWith(clearJustReplied: true);

  Future<void> openConversation(String id) async {
    state = state.copyWith(activeConversationId: id, messages: []);
    final repo = _ref.read(chatRepositoryProvider);
    final result = await repo.messages(id);
    if (result.isSuccess) {
      state = state.copyWith(messages: result.data ?? []);
    }
  }

  Future<void> send(String content) async {
    final hasAttachment = state.attachment != null;
    if ((content.trim().isEmpty && !hasAttachment) || state.sending) return;
    final repo = _ref.read(chatRepositoryProvider);
    final attachment = state.attachment;

    final displayContent = hasAttachment
        ? '📎 ${attachment!.title}${content.trim().isNotEmpty ? '\n\n$content' : ''}'
        : content;
    final userMessage = ChatMessage(
      id: 'tmp-${DateTime.now().millisecondsSinceEpoch}',
      role: 'user',
      content: displayContent,
    );
    state = state.copyWith(
      messages: [...state.messages, userMessage],
      sending: true,
      clearProviderError: true,
      clearAttachment: true,
      clearAttachError: true,
    );

    final result = await repo.sendMessage(
      conversationId: state.activeConversationId,
      content: content,
      agentId: state.agentId?.isNotEmpty == true ? state.agentId : null,
      attachmentTitle: attachment?.title,
      attachmentImageId: attachment?.isImage == true ? attachment!.id : null,
    );

    if (result.isSuccess && result.data != null) {
      final autoPlay = _ref.read(voiceSettingsControllerProvider).autoPlay;
      state = state.copyWith(
        activeConversationId: result.data!.conversationId,
        messages: [...state.messages, result.data!.assistantMessage],
        sending: false,
        justRepliedMessageId: autoPlay ? result.data!.assistantMessage.id : null,
        clearJustReplied: !autoPlay,
      );
      await loadConversations();
    } else {
      state = state.copyWith(
        sending: false,
        providerError: result.statusCode == 503
            ? (result.error ?? 'AI provider not configured')
            : result.error,
      );
    }
  }

  /// Mirrors resolveConfirmation(messageId) in Chat.jsx.
  Future<void> resolveConfirmation(String messageId, bool approved) async {
    final message = state.messages.firstWhere((m) => m.id == messageId, orElse: () => ChatMessage(id: '', role: '', content: ''));
    if (message.confirmation == null) return;

    final repo = _ref.read(chatRepositoryProvider);
    final outcome = await repo.resolveConfirmation(message.confirmation!.confirmationId, approved);

    final resolution = outcome.error != null ? 'error' : (approved ? 'approved' : 'rejected');
    unawaited(repo.persistResolution(messageId, resolution));

    final newContent = outcome.error != null
        ? '${message.content}\n\n(Could not resolve: ${outcome.error})'
        : approved
            ? '${message.content}\n\n${outcome.status == "completed" ? "Done — approved and completed." : "Not completed: ${outcome.error ?? ''}"}'
            : '${message.content}\n\nOkay, I won\'t do that.';

    state = state.copyWith(
      messages: state.messages
          .map((m) => m.id == messageId
              ? m.copyWith(
                  content: newContent,
                  confirmation: m.confirmation?.copyWith(resolution: resolution),
                )
              : m)
          .toList(),
    );
  }
}

// Deliberately NOT .autoDispose, unlike most other screen-level providers
// in this app (tasks/files/agents/automations/etc., where autoDispose is
// correct — a listing screen re-fetching fresh data on reentry has no
// downside). Chat is different: activeConversationId/messages are
// hard-to-recreate, in-progress client state, not just a cached list.
// With GoRouter's plain ShellRoute (app_router.dart), navigating to any
// other tab and back UNMOUNTS ChatScreen — with autoDispose, that tears
// down the whole ChatController and its state the moment the last
// listener drops, so the NEXT message sent conversationId: null,
// silently starting a brand-new server-side conversation instead of
// continuing the one on screen. Confirmed as the root cause of a live V2
// bug where a strategy built in one turn couldn't be found by
// getActiveStrategyForConversation() on a later turn — the two turns had
// landed in two different conversations. Same category of "must survive
// navigation" state as authControllerProvider/organizationControllerProvider
// below, for the same underlying reason.
final chatControllerProvider =
    StateNotifierProvider<ChatController, ChatState>((ref) => ChatController(ref));
