// Image generation provider abstraction — mirrors ai/provider.js (text) and
// ai/speech.js (voice). Nothing outside this file talks to an image vendor
// directly. Adding Google's image models or a future provider means one
// more providers/*.js adapter plus a registry entry here; nothing that
// calls generateImage()/editImage() has to change.
import { openaiGenerateImage, openaiEditImage, OPENAI_IMAGE_CAPABILITIES } from "./providers/openaiImage.js";
import { circuitStatus } from "./resilientFetch.js";

const REGISTRY = {
  openai: {
    generate: openaiGenerateImage,
    edit: openaiEditImage,
    keyEnv: "OPENAI_API_KEY",
    label: "OpenAI (gpt-image-1)",
    capabilities: OPENAI_IMAGE_CAPABILITIES,
    circuitKey: "openai_image",
  },
};

function defaultProviderName() {
  const configured = (process.env.IMAGE_PROVIDER || "openai").toLowerCase();
  return REGISTRY[configured] ? configured : "openai";
}

export function imageProviderStatus(name) {
  const providerName = name || defaultProviderName();
  const entry = REGISTRY[providerName];
  if (!entry) return { configured: false, provider: providerName, reason: `Unknown provider "${providerName}"` };
  const hasKey = Boolean(process.env[entry.keyEnv]);
  const circuit = circuitStatus(entry.circuitKey);
  return {
    configured: hasKey, provider: providerName, label: entry.label,
    reason: hasKey ? null : `${entry.keyEnv} is not set`, capabilities: entry.capabilities,
    healthy: circuit.state !== "open", circuitState: circuit.state,
  };
}

// Every image provider this platform could ever support, not just the
// configured ones — the UI needs to show "not configured" for the rest
// rather than pretending they don't exist (spec §40).
export function listImageProviderOptions() {
  return Object.entries(REGISTRY).map(([id, entry]) => ({
    id, label: entry.label, configured: Boolean(process.env[entry.keyEnv]), capabilities: entry.capabilities,
  }));
}

function requireProvider(name) {
  const providerName = name || defaultProviderName();
  const entry = REGISTRY[providerName];
  if (!entry) {
    const err = new Error(`Unknown image provider "${providerName}"`);
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  const apiKey = process.env[entry.keyEnv];
  if (!apiKey) {
    const err = new Error("Image generation provider not configured");
    err.code = "PROVIDER_NOT_CONFIGURED";
    err.detail = `${entry.keyEnv} is not set`;
    throw err;
  }
  return { entry, apiKey, providerName };
}

export async function generateImage({ provider, ...params }) {
  const { entry, apiKey, providerName } = requireProvider(provider);
  const result = await entry.generate({ ...params, apiKey });
  return { ...result, provider: providerName };
}

export async function editImage({ provider, ...params }) {
  const { entry, apiKey, providerName } = requireProvider(provider);
  if (!entry.edit) {
    const err = new Error(`${entry.label} doesn't support image editing.`);
    err.code = "UNSUPPORTED";
    throw err;
  }
  const result = await entry.edit({ ...params, apiKey });
  return { ...result, provider: providerName };
}
