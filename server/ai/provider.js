// Provider abstraction. The rest of the app never talks to a vendor directly;
// it calls chatComplete(), which routes to the configured provider.
import { anthropicChat } from "./providers/anthropic.js";
import { openaiChat } from "./providers/openai.js";
import { geminiChat } from "./providers/gemini.js";
import { circuitStatus } from "./resilientFetch.js";

const REGISTRY = {
  anthropic: { fn: anthropicChat, keyEnv: "ANTHROPIC_API_KEY", label: "Anthropic Claude", circuitKey: "anthropic_text" },
  openai:    { fn: openaiChat,    keyEnv: "OPENAI_API_KEY",    label: "OpenAI",           circuitKey: "openai_text" },
  gemini:    { fn: geminiChat,    keyEnv: "GEMINI_API_KEY",    label: "Google Gemini",    circuitKey: "gemini_text" },
};

export function providerStatus() {
  const name = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const entry = REGISTRY[name];
  if (!entry) return { configured: false, provider: name, reason: `Unknown provider "${name}"` };
  const hasKey = Boolean(process.env[entry.keyEnv]);
  const circuit = circuitStatus(entry.circuitKey);
  return {
    configured: hasKey, provider: name, label: entry.label,
    reason: hasKey ? null : `${entry.keyEnv} is not set`,
    // "configured" and "healthy" are different questions — a provider can
    // have a valid key but still be temporarily down after repeated
    // failures (circuit open), which the UI should show distinctly from
    // "you never set this up."
    healthy: circuit.state !== "open",
    circuitState: circuit.state,
  };
}

// Lets the Agent Builder show which providers can actually be selected —
// an agent shouldn't be allowed to pick a provider whose key was never set.
export function listProviderOptions() {
  return Object.entries(REGISTRY).map(([id, entry]) => ({
    id, label: entry.label, configured: Boolean(process.env[entry.keyEnv]),
  }));
}

// messages: [{ role: 'user'|'assistant'|'system', content: string }]
// provider/model: optional per-call override (an agent's own choice).
// apiKey: optional BYOK override — when the calling org brought its own key,
// this is passed in directly and the platform's own env-var key is never
// touched for that call. Returns { text, usage: { promptTokens, completionTokens } }.
export async function chatComplete({ messages, systemPrompt, provider, model, apiKey: byokKey }) {
  const providerName = (provider || process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const entry = REGISTRY[providerName];
  if (!entry) {
    const err = new Error(`Unknown AI provider "${providerName}"`);
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  const apiKey = byokKey || process.env[entry.keyEnv];
  if (!apiKey) {
    const err = new Error("AI provider not configured");
    err.code = "PROVIDER_NOT_CONFIGURED";
    err.detail = provider
      ? `This agent is set to use ${entry.label}, but ${entry.keyEnv} is not set.`
      : `${entry.keyEnv} is not set`;
    throw err;
  }
  return entry.fn({ messages, systemPrompt, apiKey, model });
}
