// Provider-agnostic web search. Adding Brave/SerpAPI/etc later means: write
// a file in ./ with a { search(query) } export, register it below, done —
// nothing in the Tool Registry or Orchestrator changes.
import { tavilySearch } from "./tavily.js";
import { braveSearch } from "./brave.js";
import { serpapiSearch } from "./serpapi.js";

const REGISTRY = {
  tavily: { fn: tavilySearch, keyEnv: "TAVILY_API_KEY", label: "Tavily" },
  brave: { fn: braveSearch, keyEnv: "BRAVE_API_KEY", label: "Brave Search" },
  serpapi: { fn: serpapiSearch, keyEnv: "SERPAPI_API_KEY", label: "SerpAPI" },
};

export function searchProviderStatus() {
  const name = (process.env.SEARCH_PROVIDER || "tavily").toLowerCase();
  const entry = REGISTRY[name];
  if (!entry) return { configured: false, provider: name, reason: `Unknown search provider "${name}"` };
  const hasKey = Boolean(process.env[entry.keyEnv]);
  return { configured: hasKey, provider: name, label: entry.label, reason: hasKey ? null : `${entry.keyEnv} is not set` };
}

// Returns: [{ title, url, snippet }]
export async function performWebSearch(query) {
  const status = searchProviderStatus();
  if (!status.configured) {
    const err = new Error("Web search provider not configured");
    err.code = "SEARCH_NOT_CONFIGURED";
    err.detail = status.reason;
    throw err;
  }
  const entry = REGISTRY[status.provider];
  return entry.fn({ query, apiKey: process.env[entry.keyEnv] });
}
