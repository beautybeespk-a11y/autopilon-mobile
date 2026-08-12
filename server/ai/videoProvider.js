// Video Generation Provider abstraction (spec §6/§27). No adapter is
// actually implemented in this pass — Veo, Kling, and Runway all require
// separate paid API accounts with credentials this environment doesn't
// have (and shouldn't provision without being asked). This file exists so
// the rest of the Content Studio (routes, UI, tools) has a single, honest
// place to ask "is video generation available" and so a real adapter can
// be dropped in later without anything else changing — same shape as
// imageProvider.js: generate({ prompt, ... }) -> { videoBuffer, mimeType, provider, model }.
//
// KNOWN_PROVIDERS is deliberately listed even though nothing is registered
// — the UI shows each one as "not configured" rather than making video
// generation look like it doesn't exist as a feature at all.
const KNOWN_PROVIDERS = [
  { id: "veo", label: "Google Veo", keyEnv: "GOOGLE_VEO_API_KEY" },
  { id: "kling", label: "Kling", keyEnv: "KLING_API_KEY" },
  { id: "runway", label: "Runway", keyEnv: "RUNWAY_API_KEY" },
];

// A future adapter registers itself here, e.g.:
//   REGISTRY.veo = { generate: veoGenerateVideo, capabilities: {...} };
const REGISTRY = {};

export function videoProviderStatus(name) {
  const providerName = (name || process.env.VIDEO_PROVIDER || KNOWN_PROVIDERS[0].id).toLowerCase();
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

export function listVideoProviderOptions() {
  return KNOWN_PROVIDERS.map((p) => ({ ...videoProviderStatus(p.id) }));
}

export async function generateVideo() {
  const err = new Error("Video generation isn't available yet — no video provider (Veo, Kling, Runway) is configured.");
  err.code = "PROVIDER_NOT_CONFIGURED";
  throw err;
}
