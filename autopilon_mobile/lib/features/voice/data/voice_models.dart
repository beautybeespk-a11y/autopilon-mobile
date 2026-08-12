class VoiceSettings {
  final String voice;
  final String? language; // null = auto-detect
  final double speed;
  final double volume;
  final bool autoPlay;
  final String voiceMode; // 'tap' — 'continuous' reserved for a future natural-voice-mode pass
  final bool captions;

  const VoiceSettings({
    required this.voice,
    this.language,
    required this.speed,
    required this.volume,
    required this.autoPlay,
    required this.voiceMode,
    required this.captions,
  });

  factory VoiceSettings.fromJson(Map<String, dynamic> json) => VoiceSettings(
        voice: json['voice'] as String? ?? 'alloy',
        language: json['language'] as String?,
        speed: (json['speed'] as num?)?.toDouble() ?? 1.0,
        volume: (json['volume'] as num?)?.toDouble() ?? 1.0,
        autoPlay: json['autoPlay'] as bool? ?? true,
        voiceMode: json['voiceMode'] as String? ?? 'tap',
        captions: json['captions'] as bool? ?? true,
      );

  Map<String, dynamic> toJson() => {
        'voice': voice,
        'language': language,
        'speed': speed,
        'volume': volume,
        'autoPlay': autoPlay,
        'voiceMode': voiceMode,
        'captions': captions,
      };

  VoiceSettings copyWith({
    String? voice,
    String? language,
    double? speed,
    double? volume,
    bool? autoPlay,
    String? voiceMode,
    bool? captions,
  }) =>
      VoiceSettings(
        voice: voice ?? this.voice,
        language: language ?? this.language,
        speed: speed ?? this.speed,
        volume: volume ?? this.volume,
        autoPlay: autoPlay ?? this.autoPlay,
        voiceMode: voiceMode ?? this.voiceMode,
        captions: captions ?? this.captions,
      );
}

class VoiceOption {
  final String id;
  final String label;
  const VoiceOption({required this.id, required this.label});
  factory VoiceOption.fromJson(Map<String, dynamic> json) =>
      VoiceOption(id: json['id'] as String? ?? '', label: json['label'] as String? ?? '');
}

class VoiceStatus {
  final bool sttConfigured;
  final String? sttReason;
  final bool ttsConfigured;
  final String? ttsReason;
  final List<VoiceOption> voices;

  const VoiceStatus({
    required this.sttConfigured,
    this.sttReason,
    required this.ttsConfigured,
    this.ttsReason,
    required this.voices,
  });

  factory VoiceStatus.fromJson(Map<String, dynamic> json) => VoiceStatus(
        sttConfigured: (json['stt'] as Map?)?['configured'] as bool? ?? false,
        sttReason: (json['stt'] as Map?)?['reason'] as String?,
        ttsConfigured: (json['tts'] as Map?)?['configured'] as bool? ?? false,
        ttsReason: (json['tts'] as Map?)?['reason'] as String?,
        voices: (json['voices'] as List? ?? [])
            .map((v) => VoiceOption.fromJson(v as Map<String, dynamic>))
            .toList(),
      );
}

class TranscriptionResult {
  final String text;
  final String? language;
  final double? durationSeconds;
  const TranscriptionResult({required this.text, this.language, this.durationSeconds});

  factory TranscriptionResult.fromJson(Map<String, dynamic> json) => TranscriptionResult(
        text: json['text'] as String? ?? '',
        language: json['language'] as String?,
        durationSeconds: (json['durationSeconds'] as num?)?.toDouble(),
      );
}
