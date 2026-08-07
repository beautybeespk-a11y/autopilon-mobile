import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
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

  const ChatState({
    this.conversations = const [],
    this.agents = const [],
    this.agentId,
    this.activeConversationId,
    this.messages = const [],
    this.sending = false,
    this.providerError,
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
  }) =>
      ChatState(
        conversations: conversations ?? this.conversations,
        agents: agents ?? this.agents,
        agentId: agentId ?? this.agentId,
        activeConversationId: clearActiveConversation ? null : (activeConversationId ?? this.activeConversationId),
        messages: messages ?? this.messages,
        sending: sending ?? this.sending,
        providerError: clearProviderError ? null : (providerError ?? this.providerError),
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
    state = state.copyWith(clearActiveConversation: true, messages: []);
  }

  Future<void> openConversation(String id) async {
    state = state.copyWith(activeConversationId: id, messages: []);
    final repo = _ref.read(chatRepositoryProvider);
    final result = await repo.messages(id);
    if (result.isSuccess) {
      state = state.copyWith(messages: result.data ?? []);
    }
  }

  Future<void> send(String content) async {
    if (content.trim().isEmpty || state.sending) return;
    final repo = _ref.read(chatRepositoryProvider);

    final userMessage = ChatMessage(
      id: 'tmp-${DateTime.now().millisecondsSinceEpoch}',
      role: 'user',
      content: content,
    );
    state = state.copyWith(messages: [...state.messages, userMessage], sending: true, clearProviderError: true);

    final result = await repo.sendMessage(
      conversationId: state.activeConversationId,
      content: content,
      agentId: state.agentId?.isNotEmpty == true ? state.agentId : null,
    );

    if (result.isSuccess && result.data != null) {
      state = state.copyWith(
        activeConversationId: result.data!.conversationId,
        messages: [...state.messages, result.data!.assistantMessage],
        sending: false,
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

final chatControllerProvider =
    StateNotifierProvider.autoDispose<ChatController, ChatState>((ref) => ChatController(ref));
