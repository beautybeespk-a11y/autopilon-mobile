import 'dart:io';
import '../../../core/api/api_client.dart';
import 'chat_models.dart';

class SendResult {
  final String conversationId;
  final ChatMessage assistantMessage;
  SendResult({required this.conversationId, required this.assistantMessage});
}

class ConfirmationOutcome {
  final String? status;
  final String? error;
  final bool alreadyHandled;
  ConfirmationOutcome({this.status, this.error, this.alreadyHandled = false});
}

class ChatRepository {
  ChatRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<List<Conversation>>> conversations() => _api.get<List<Conversation>>(
        '/chat/conversations',
        parse: (data) => (data as List).map((c) => Conversation.fromJson(c)).toList(),
      );

  Future<ApiResult<List<ChatAgent>>> agents() => _api.get<List<ChatAgent>>(
        '/agents',
        parse: (data) => (data as List).map((a) => ChatAgent.fromJson(a)).toList(),
      );

  Future<ApiResult<List<ChatMessage>>> messages(String conversationId) => _api.get<List<ChatMessage>>(
        '/chat/conversations/$conversationId/messages',
        parse: (data) => (data as List).map((m) => ChatMessage.fromJson(m)).toList(),
      );

  /// Uploads a picked photo to the Knowledge Library and returns its item id
  /// — that id (not the image bytes) is what sendMessage() below sends along
  /// with the next chat message, so the server can read the file off disk
  /// and hand it to the AI provider as a vision input.
  Future<ApiResult<UploadedAttachment>> uploadAttachment(File file) => _api.uploadFile<UploadedAttachment>(
        '/research/knowledge/upload',
        file,
        parse: (data) => UploadedAttachment.fromJson(data as Map<String, dynamic>),
      );

  /// Mirrors Chat.jsx's sendMessage: posts content (+ optional agentId and
  /// attachment), gets back the conversationId (new if this was the first
  /// message) and the assistant's reply — including trace, tool results, and
  /// any confirmation the assistant is waiting on before it'll run a tool.
  Future<ApiResult<SendResult>> sendMessage({
    String? conversationId,
    required String content,
    String? agentId,
    String? attachmentTitle,
    String? attachmentImageId,
  }) =>
      _api.post<SendResult>(
        '/chat/message',
        body: {
          'conversationId': conversationId,
          'content': content,
          if (agentId != null) 'agentId': agentId,
          if (attachmentTitle != null) 'attachmentTitle': attachmentTitle,
          if (attachmentImageId != null) 'attachmentImageId': attachmentImageId,
        },
        parse: (data) {
          final d = data as Map<String, dynamic>;
          return SendResult(
            conversationId: d['conversationId']?.toString() ?? '',
            assistantMessage: ChatMessage(
              id: d['assistantMessageId']?.toString() ?? 'a-${DateTime.now().millisecondsSinceEpoch}',
              role: 'assistant',
              content: d['reply'] ?? '',
              trace: d['trace'] as List<dynamic>?,
              confirmation: d['confirmation'] != null
                  ? Confirmation.fromJson(d['confirmation'] as Map<String, dynamic>)
                  : null,
            ),
          );
        },
      );

  /// Approve/reject a pending tool confirmation. Mirrors ConfirmationCard's
  /// resolve(): treats a 409/410 (already resolved elsewhere) as "completed",
  /// not as a fresh error.
  Future<ConfirmationOutcome> resolveConfirmation(String confirmationId, bool approved) async {
    final path = '/confirmations/$confirmationId/${approved ? "approve" : "reject"}';
    final result = await _api.post<Map<String, dynamic>>(path, body: const {}, parse: (d) => d as Map<String, dynamic>);
    if (result.isSuccess) {
      return ConfirmationOutcome(status: result.data?['status']);
    }
    final alreadyHandled = result.statusCode == 409 || result.statusCode == 410;
    if (alreadyHandled) {
      return ConfirmationOutcome(status: 'completed', alreadyHandled: true);
    }
    return ConfirmationOutcome(error: result.error);
  }

  /// Persists the resolution onto the stored message so a page reload shows
  /// the outcome instead of stale pending buttons. Fire-and-forget, same as
  /// the web client's .catch(() => {}).
  Future<void> persistResolution(String messageId, String resolution) async {
    try {
      await _api.patch<void>('/chat/messages/$messageId/confirmation', body: {'resolution': resolution}, parse: (_) {});
    } catch (_) {
      // Intentionally swallowed — matches web client behavior.
    }
  }
}
