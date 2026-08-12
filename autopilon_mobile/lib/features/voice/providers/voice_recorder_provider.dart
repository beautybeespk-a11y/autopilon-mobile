import 'dart:async';
import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'voice_settings_provider.dart';

enum VoiceRecorderStatus { idle, recording, transcribing, error }

class VoiceRecorderState {
  final VoiceRecorderStatus status;
  final int elapsedSeconds;
  final String? error;
  final String? transcript; // set once per recording; the composer consumes it then calls clearTranscript()

  const VoiceRecorderState({
    this.status = VoiceRecorderStatus.idle,
    this.elapsedSeconds = 0,
    this.error,
    this.transcript,
  });

  VoiceRecorderState copyWith({
    VoiceRecorderStatus? status,
    int? elapsedSeconds,
    String? error,
    bool clearError = false,
    String? transcript,
    bool clearTranscript = false,
  }) =>
      VoiceRecorderState(
        status: status ?? this.status,
        elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
        error: clearError ? null : (error ?? this.error),
        transcript: clearTranscript ? null : (transcript ?? this.transcript),
      );
}

/// Wraps the `record` package's mic capture and hands the result to
/// POST /voice/transcribe. Deliberately doesn't touch the AI Orchestrator or
/// send anything itself — the composer is responsible for putting the
/// transcript in front of the user and only sending it through the normal
/// chat/message flow once they confirm, so a voice message goes through
/// exactly the same permission/approval/quota path as typed text.
class VoiceRecorderController extends StateNotifier<VoiceRecorderState> {
  VoiceRecorderController(this._ref) : super(const VoiceRecorderState());
  final Ref _ref;
  final _recorder = AudioRecorder();
  Timer? _timer;
  String? _path;

  Future<void> start() async {
    if (state.status == VoiceRecorderStatus.recording) return;
    final hasPermission = await _recorder.hasPermission();
    if (!hasPermission) {
      state = state.copyWith(
        status: VoiceRecorderStatus.error,
        error: 'Microphone permission was denied. Allow microphone access in your device settings to use voice input.',
      );
      return;
    }
    final dir = await getTemporaryDirectory();
    _path = '${dir.path}/voice-message-${DateTime.now().millisecondsSinceEpoch}.m4a';
    try {
      await _recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc), path: _path!);
    } catch (err) {
      state = state.copyWith(status: VoiceRecorderStatus.error, error: "Couldn't start recording: $err");
      return;
    }
    state = const VoiceRecorderState(status: VoiceRecorderStatus.recording);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      state = state.copyWith(elapsedSeconds: state.elapsedSeconds + 1);
    });
  }

  Future<void> cancel() async {
    _timer?.cancel();
    if (state.status == VoiceRecorderStatus.recording) {
      await _recorder.cancel();
    }
    state = const VoiceRecorderState();
  }

  Future<void> stopAndTranscribe({String? agentId, String? conversationId}) async {
    if (state.status != VoiceRecorderStatus.recording) return;
    _timer?.cancel();
    final stoppedPath = await _recorder.stop();
    final filePath = stoppedPath ?? _path;
    if (filePath == null || !await File(filePath).exists()) {
      state = state.copyWith(status: VoiceRecorderStatus.error, error: "Couldn't save that recording.");
      return;
    }
    state = state.copyWith(status: VoiceRecorderStatus.transcribing, elapsedSeconds: 0);
    final repo = _ref.read(voiceRepositoryProvider);
    final result = await repo.transcribe(File(filePath), agentId: agentId, conversationId: conversationId);
    File(filePath).delete().catchError((_) => File(filePath)); // best-effort cleanup of the local recording
    if (result.isSuccess && result.data != null) {
      state = VoiceRecorderState(status: VoiceRecorderStatus.idle, transcript: result.data!.text);
    } else {
      state = VoiceRecorderState(
        status: VoiceRecorderStatus.error,
        error: result.statusCode == 503 ? (result.error ?? 'Voice input is not configured.') : (result.error ?? "Couldn't transcribe that recording."),
      );
    }
  }

  void clearTranscript() => state = state.copyWith(clearTranscript: true);
  void dismissError() => state = const VoiceRecorderState();

  @override
  void dispose() {
    _timer?.cancel();
    _recorder.dispose();
    super.dispose();
  }
}

final voiceRecorderControllerProvider =
    StateNotifierProvider.autoDispose<VoiceRecorderController, VoiceRecorderState>((ref) => VoiceRecorderController(ref));
