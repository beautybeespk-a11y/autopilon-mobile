import 'dart:io';
import 'dart:typed_data';
import '../../../core/api/api_client.dart';
import 'voice_models.dart';

class VoiceRepository {
  VoiceRepository(this._api);
  final ApiClient _api;

  Future<ApiResult<VoiceStatus>> status() =>
      _api.get<VoiceStatus>('/voice/status', parse: (d) => VoiceStatus.fromJson(d as Map<String, dynamic>));

  Future<ApiResult<VoiceSettings>> getSettings() =>
      _api.get<VoiceSettings>('/voice/settings', parse: (d) => VoiceSettings.fromJson(d as Map<String, dynamic>));

  Future<ApiResult<VoiceSettings>> updateSettings(Map<String, dynamic> patch) => _api.patch<VoiceSettings>(
        '/voice/settings',
        body: patch,
        parse: (d) => VoiceSettings.fromJson(d as Map<String, dynamic>),
      );

  /// Uploads a recorded voice message and gets back its transcript — the
  /// caller (the chat composer) is expected to show it for review/edit and
  /// only send it through the ordinary chat/message flow once the user
  /// confirms, exactly like the web client.
  Future<ApiResult<TranscriptionResult>> transcribe(File audioFile, {String? agentId, String? conversationId}) =>
      _api.uploadAudio<TranscriptionResult>(
        '/voice/transcribe',
        audioFile,
        fields: {
          if (agentId != null && agentId.isNotEmpty) 'agentId': agentId,
          if (conversationId != null && conversationId.isNotEmpty) 'conversationId': conversationId,
        },
        parse: (d) => TranscriptionResult.fromJson(d as Map<String, dynamic>),
      );

  Future<ApiResult<Uint8List>> speak(String text, {String? voice, double? speed}) => _api.postBytes(
        '/voice/speak',
        body: {
          'text': text,
          if (voice != null) 'voice': voice,
          if (speed != null) 'speed': speed,
        },
      );
}
