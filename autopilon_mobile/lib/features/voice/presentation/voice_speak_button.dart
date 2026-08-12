import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../providers/voice_settings_provider.dart';

const _maxSpeakableChars = 4000; // mirrors server/routes/voice.js's /speak cap

enum _SpeakState { idle, loading, playing, error }

/// Fetches TTS audio for one message's text on demand — playing is either a
/// deliberate tap, or (via [autoPlay]) limited to the single reply that just
/// arrived, so this never eagerly speaks every message in a conversation.
class VoiceSpeakButton extends ConsumerStatefulWidget {
  const VoiceSpeakButton({super.key, required this.text, this.autoPlay = false, this.onAutoPlayed});
  final String text;
  final bool autoPlay;
  final VoidCallback? onAutoPlayed;

  @override
  ConsumerState<VoiceSpeakButton> createState() => _VoiceSpeakButtonState();
}

class _VoiceSpeakButtonState extends ConsumerState<VoiceSpeakButton> {
  _SpeakState _state = _SpeakState.idle;
  final _player = AudioPlayer();

  @override
  void initState() {
    super.initState();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _state = _SpeakState.idle);
    });
    if (widget.autoPlay) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _play();
        widget.onAutoPlayed?.call();
      });
    }
  }

  Future<void> _play() async {
    if (_state == _SpeakState.loading) return;
    if (_state == _SpeakState.playing) {
      await _player.stop();
      if (mounted) setState(() => _state = _SpeakState.idle);
      return;
    }
    setState(() => _state = _SpeakState.loading);
    final settings = ref.read(voiceSettingsControllerProvider);
    final repo = ref.read(voiceRepositoryProvider);
    final result = await repo.speak(widget.text, voice: settings.voice, speed: settings.speed);
    if (!mounted) return;
    if (result.isSuccess && result.data != null) {
      await _player.setVolume(settings.volume);
      await _player.play(BytesSource(result.data!, mimeType: 'audio/mpeg'));
      if (mounted) setState(() => _state = _SpeakState.playing);
    } else {
      setState(() => _state = _SpeakState.error);
    }
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.text.length > _maxSpeakableChars) return const SizedBox.shrink();
    return IconButton(
      icon: _state == _SpeakState.loading
          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(
              _state == _SpeakState.playing ? Icons.stop_circle_outlined : Icons.volume_up_outlined,
              size: 18,
              color: _state == _SpeakState.error
                  ? Colors.red
                  : (_state == _SpeakState.playing ? Theme.of(context).colorScheme.primary : Colors.grey),
            ),
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(),
      tooltip: _state == _SpeakState.error ? "Couldn't play" : 'Play reply aloud',
      onPressed: _play,
    );
  }
}
