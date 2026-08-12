// Audio/Music Generation Provider abstraction (spec §11/§27) — background
// music, sound effects, and general AI audio (distinct from the
// voiceover/TTS pipeline, which already exists and is real — see
// ai/speech.js from Phase 13). No music-generation provider is configured
// or implemented in this pass; this is architecture only, same reasoning
// and shape as videoProvider.js.
const KNOWN_PROVIDERS = [
  { id: "elevenlabs_music", label: "ElevenLabs Music", keyEnv: "ELEVENLABS_API_KEY" },
  { id: "suno", label: "Suno", keyEnv: "SUNO_API_KEY" },
];

const REGISTRY = {};

export function audioProviderStatus(name) {
  const providerName = (name || process.env.AUDIO_PROVIDER || KNOWN_PROVIDERS[0].id).toLowerCase();
  const known = KNOWN_PROVIDERS.find((p) => p.id === providerName);
  if (!known) return { configured: false, provider: providerName, reason: `Unknown provider "${providerName}"` };
  const implemented = Boolean(REGISTRY[known.id]);
  const hasKey = Boolean(process.env[known.keyEnv]);
  return {
    configured: implemented && hasKey,
    provider: known.id,
    label: known.label,
    reason: !implemented
      ? `${known.label} isn't integrated yet — this is architecture only until a future pass wires it up.`
      : hasKey ? null : `${known.keyEnv} is not set`,
  };
}

export function listAudioProviderOptions() {
  return KNOWN_PROVIDERS.map((p) => ({ ...audioProviderStatus(p.id) }));
}

export async function generateAudio() {
  const err = new Error("Music/audio generation isn't available yet — no audio provider is configured. Voiceovers (text-to-speech) already work — see the Voice system.");
  err.code = "PROVIDER_NOT_CONFIGURED";
  throw err;
}
