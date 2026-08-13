// Speech provider abstraction — the voice route never talks to a vendor
// directly, same principle as chatComplete() in provider.js. Adding Google
// Cloud Speech, Azure Speech, or ElevenLabs later means adding an entry to
// these two registries and a providers/*.js adapter; nothing that calls
// transcribeAudio()/synthesizeSpeech() below has to change.
import { openaiTranscribe, openaiSynthesize, OPENAI_VOICES } from "./providers/openaiVoice.js";
import { circuitStatus } from "./resilientFetch.js";

const STT_REGISTRY = {
  openai: { fn: openaiTranscribe, keyEnv: "OPENAI_API_KEY", label: "OpenAI Whisper", circuitKey: "openai_stt" },
};
const TTS_REGISTRY = {
  openai: { fn: openaiSynthesize, keyEnv: "OPENAI_API_KEY", label: "OpenAI TTS", voices: OPENAI_VOICES, circuitKey: "openai_tts" },
};

function defaultProviderName(registry, envVar) {
  const configured = (process.env[envVar] || "openai").toLowerCase();
  return registry[configured] ? configured : "openai";
}

export function sttStatus() {
  const name = defaultProviderName(STT_REGISTRY, "STT_PROVIDER");
  const entry = STT_REGISTRY[name];
  const hasKey = Boolean(process.env[entry.keyEnv]);
  const circuit = circuitStatus(entry.circuitKey);
  return {
    configured: hasKey, provider: name, label: entry.label, reason: hasKey ? null : `${entry.keyEnv} is not set`,
    healthy: circuit.state !== "open", circuitState: circuit.state,
  };
}

export function ttsStatus() {
  const name = defaultProviderName(TTS_REGISTRY, "TTS_PROVIDER");
  const entry = TTS_REGISTRY[name];
  const hasKey = Boolean(process.env[entry.keyEnv]);
  const circuit = circuitStatus(entry.circuitKey);
  return {
    configured: hasKey, provider: name, label: entry.label, reason: hasKey ? null : `${entry.keyEnv} is not set`,
    healthy: circuit.state !== "open", circuitState: circuit.state,
  };
}

export function listVoices() {
  const name = defaultProviderName(TTS_REGISTRY, "TTS_PROVIDER");
  return TTS_REGISTRY[name].voices || [];
}

// filePath: audio already saved to disk by multer (same "upload to disk,
// pass a reference, never push raw bytes through a JSON body" pattern used
// for image attachments in research.js/conversationService.js).
export async function transcribeAudio({ filePath, filename, mimeType, provider, language }) {
  const providerName = provider || defaultProviderName(STT_REGISTRY, "STT_PROVIDER");
  const entry = STT_REGISTRY[providerName];
  if (!entry) {
    const err = new Error(`Unknown speech-to-text provider "${providerName}"`);
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  const apiKey = process.env[entry.keyEnv];
  if (!apiKey) {
    const err = new Error("Speech-to-text provider not configured");
    err.code = "PROVIDER_NOT_CONFIGURED";
    err.detail = `${entry.keyEnv} is not set`;
    throw err;
  }
  const result = await entry.fn({ filePath, filename, mimeType, apiKey, language });
  return { ...result, provider: providerName };
}

export async function synthesizeSpeech({ text, provider, voice, speed }) {
  const providerName = provider || defaultProviderName(TTS_REGISTRY, "TTS_PROVIDER");
  const entry = TTS_REGISTRY[providerName];
  if (!entry) {
    const err = new Error(`Unknown text-to-speech provider "${providerName}"`);
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  const apiKey = process.env[entry.keyEnv];
  if (!apiKey) {
    const err = new Error("Text-to-speech provider not configured");
    err.code = "PROVIDER_NOT_CONFIGURED";
    err.detail = `${entry.keyEnv} is not set`;
    throw err;
  }
  const result = await entry.fn({ text, apiKey, voice, speed });
  return { ...result, provider: providerName };
}
