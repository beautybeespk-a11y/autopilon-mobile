// Shared resilience wrapper for every AI provider adapter (Phase 16 §7) —
// timeouts, safe retries, and a per-provider circuit breaker, all in one
// place so no individual adapter (anthropic.js, openai.js, gemini.js,
// openaiImage.js, openaiVoice.js) has to reimplement this. Swaps in for a
// bare `fetch(url, options)` call with no change to how the caller reads
// the Response — only how getting one there is protected.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2; // total attempts = 1 + retries
const RETRY_BASE_DELAY_MS = 500;

const FAILURE_THRESHOLD = 5; // consecutive failures before the circuit opens
const COOLDOWN_MS = 30_000; // how long it stays open before allowing one trial request

const circuits = new Map(); // circuitKey -> { state, consecutiveFailures, openedAt, lastError }

function getCircuit(key) {
  if (!circuits.has(key)) circuits.set(key, { state: "closed", consecutiveFailures: 0, openedAt: null, lastError: null });
  return circuits.get(key);
}

function recordSuccess(key) {
  const c = getCircuit(key);
  c.state = "closed";
  c.consecutiveFailures = 0;
  c.openedAt = null;
  c.lastError = null;
}

function recordFailure(key, message) {
  const c = getCircuit(key);
  c.consecutiveFailures += 1;
  c.lastError = message;
  if (c.consecutiveFailures >= FAILURE_THRESHOLD && c.state !== "open") {
    c.state = "open";
    c.openedAt = Date.now();
  }
}

// Read-only projection for status endpoints/UI — never mutates state itself
// (the actual open -> half_open transition only happens inside
// resilientFetch, at the moment a real request would be attempted).
export function circuitStatus(key) {
  const c = getCircuit(key);
  const halfOpenNow = c.state === "open" && c.openedAt && Date.now() - c.openedAt >= COOLDOWN_MS;
  return { ...c, state: halfOpenNow ? "half_open" : c.state };
}

// 5xx = the provider's own problem, worth retrying. 429 = rate limited,
// also worth retrying (with backoff). Anything else in the 4xx range (bad
// request, invalid key, content policy) will not succeed on retry — retrying
// those just wastes time and, worse, could look like "safely retrying a
// dangerous action" the spec explicitly warns against.
function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} circuitKey - stable id per provider+capability (e.g. "openai_image", "anthropic_text")
 */
export async function resilientFetch(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, circuitKey } = {}) {
  if (circuitKey) {
    const c = getCircuit(circuitKey);
    if (c.state === "open") {
      if (Date.now() - c.openedAt < COOLDOWN_MS) {
        const err = new Error(`This provider is temporarily unavailable after repeated failures. Last error: ${c.lastError || "unknown"}`);
        err.code = "CIRCUIT_OPEN";
        throw err;
      }
      c.state = "half_open"; // let exactly one real request through as a trial
    }
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        if (circuitKey) recordSuccess(circuitKey);
        return res;
      }
      if (!isRetryableStatus(res.status) || attempt === retries) {
        // Non-retryable (4xx) or out of attempts — hand the Response back
        // so the caller's existing `if (!res.ok) throw new Error(...)`
        // logic (which reads the real error body) keeps working unchanged.
        // A retryable status that ran out of attempts still counts as a
        // circuit failure; a non-retryable one does NOT — a bad prompt or
        // invalid key isn't the provider being unhealthy.
        if (circuitKey && isRetryableStatus(res.status)) recordFailure(circuitKey, `HTTP ${res.status}`);
        else if (circuitKey) recordSuccess(circuitKey);
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === "AbortError" ? new Error(`Request timed out after ${timeoutMs}ms`) : err;
      if (attempt === retries) {
        if (circuitKey) recordFailure(circuitKey, lastErr.message);
        throw lastErr;
      }
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
  // Unreachable in practice (the loop always returns or throws on the last
  // attempt), kept only so the function has an explicit exhaustive exit.
  throw lastErr;
}
