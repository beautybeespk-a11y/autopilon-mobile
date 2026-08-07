class Conversation {
  final String id;
  final String title;
  Conversation({required this.id, required this.title});
  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: json['id']?.toString() ?? '',
        title: json['title'] ?? 'Untitled',
      );
}

class ChatAgent {
  final String id;
  final String name;
  ChatAgent({required this.id, required this.name});
  factory ChatAgent.fromJson(Map<String, dynamic> json) => ChatAgent(
        id: json['id']?.toString() ?? '',
        name: json['name'] ?? '',
      );
}

class Confirmation {
  final String confirmationId;
  final String toolName;
  final String? resolution; // "approved" | "rejected" | null (pending)
  Confirmation({required this.confirmationId, required this.toolName, this.resolution});

  factory Confirmation.fromJson(Map<String, dynamic> json) => Confirmation(
        confirmationId: json['confirmationId']?.toString() ?? '',
        toolName: json['toolName'] ?? '',
        resolution: json['resolution'],
      );

  Confirmation copyWith({String? resolution}) => Confirmation(
        confirmationId: confirmationId,
        toolName: toolName,
        resolution: resolution ?? this.resolution,
      );
}

class ChatMessage {
  final String id;
  final String role; // "user" | "assistant"
  final String content;
  final List<dynamic>? trace;
  final Confirmation? confirmation;

  ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.trace,
    this.confirmation,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: json['id']?.toString() ?? '',
        role: json['role'] ?? 'assistant',
        content: json['content'] ?? '',
        trace: json['trace'] as List<dynamic>?,
        confirmation: json['confirmation'] != null
            ? Confirmation.fromJson(json['confirmation'] as Map<String, dynamic>)
            : null,
      );

  ChatMessage copyWith({String? content, Confirmation? confirmation, bool clearConfirmation = false}) =>
      ChatMessage(
        id: id,
        role: role,
        content: content ?? this.content,
        trace: trace,
        confirmation: clearConfirmation ? null : (confirmation ?? this.confirmation),
      );
}

/// Tools that mutate something real (campaigns, memory, saved research) —
/// mirrors META_ACTION_TOOLS / isDeleteAction in Chat.jsx, used only for
/// button labels ("Delete" vs "Approve", "Cancel" vs "Reject").
bool isDeleteAction(String toolName) => toolName == 'delete_memory' || toolName == 'delete_saved_research';

const metaActionTools = {'create_campaign', 'update_campaign', 'pause_campaign', 'resume_campaign'};
