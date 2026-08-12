import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';
import '../data/voice_models.dart';
import '../data/voice_repository.dart';

final voiceRepositoryProvider = Provider<VoiceRepository>((ref) {
  final apiClientAsync = ref.watch(apiClientProvider);
  return VoiceRepository(apiClientAsync.requireValue);
});

const _defaultVoiceSettings = VoiceSettings(
  voice: 'alloy', speed: 1.0, volume: 1.0, autoPlay: true, voiceMode: 'tap', captions: true,
);

/// Loaded once at app start (mirrors AuthController's _restoreSession
/// pattern) and kept live for the rest of the session — both the chat
/// composer (autoPlay) and the voice speak buttons (voice/speed/volume)
/// read from this single source instead of each re-fetching.
class VoiceSettingsController extends StateNotifier<VoiceSettings> {
  VoiceSettingsController(this._ref) : super(_defaultVoiceSettings) {
    _load();
  }
  final Ref _ref;

  Future<void> _load() async {
    final repo = _ref.read(voiceRepositoryProvider);
    final result = await repo.getSettings();
    if (result.isSuccess && result.data != null) state = result.data!;
  }

  Future<void> update(VoiceSettings next) async {
    state = next; // optimistic — this is a preference toggle, not an action worth blocking the UI on
    final repo = _ref.read(voiceRepositoryProvider);
    final result = await repo.updateSettings(next.toJson());
    if (result.isSuccess && result.data != null) state = result.data!;
  }
}

final voiceSettingsControllerProvider =
    StateNotifierProvider<VoiceSettingsController, VoiceSettings>((ref) => VoiceSettingsController(ref));

final voiceStatusProvider = FutureProvider<VoiceStatus>((ref) async {
  final repo = ref.watch(voiceRepositoryProvider);
  final result = await repo.status();
  return result.data ??
      const VoiceStatus(sttConfigured: false, ttsConfigured: false, voices: []);
});
