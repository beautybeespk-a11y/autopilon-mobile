import fs from "fs";
import { resilientFetch } from "../resilientFetch.js";

// Voiceover text can be long (up to 4000 chars, per routes/voice.js's own
// cap) and transcription audio can run several minutes — the default 30s
// is too tight for either. retries: 0 for the same reason as image
// generation: a false timeout retry risks a second, separately-billed
// synthesis/transcription rather than a free retry.
const VOICE_RESILIENCE = (circuitKey) => ({ timeoutMs: 60_000, retries: 0, circuitKey });

// Whisper accepts the language as an ISO-639-1 hint but auto-detects when
// omitted — verbose_json is requested specifically so the detected language
// and audio duration come back without a second call.
export async function openaiTranscribe({ filePath, filename, mimeType, apiKey, language }) {
  const model = process.env.OPENAI_STT_MODEL || "whisper-1";
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), filename || "audio.webm");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language);

  const res = await resilientFetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, VOICE_RESILIENCE("openai_stt"));
  if (!res.ok) throw new Error(`OpenAI transcription error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    text: data.text || "",
    language: data.language || null,
    durationSeconds: typeof data.duration === "number" ? data.duration : null,
  };
}

// tts-1 is optimized for latency (good for a chat reply being spoken back
// quickly); tts-1-hd trades that for audio quality. Either can be selected
// per-request by the caller — this just supplies a sane default.
export async function openaiSynthesize({ text, apiKey, voice, speed }) {
  const model = process.env.OPENAI_TTS_MODEL || "tts-1";
  const res = await resilientFetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: text,
      voice: voice || "alloy",
      speed: speed || 1.0,
      response_format: "mp3",
    }),
  }, VOICE_RESILIENCE("openai_tts"));
  if (!res.ok) throw new Error(`OpenAI speech error ${res.status}: ${await res.text()}`);
  const arrayBuffer = await res.arrayBuffer();
  return { audio: Buffer.from(arrayBuffer), mimeType: "audio/mpeg" };
}

// Fixed set OpenAI currently offers — there's no "list voices" endpoint to
// query, so this is the closest thing to a registry for the UI to render.
export const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "onyx", label: "Onyx" },
  { id: "nova", label: "Nova" },
  { id: "shimmer", label: "Shimmer" },
];
