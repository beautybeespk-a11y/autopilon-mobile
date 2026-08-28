// TEMPORARY diagnostic tracing for the Meta Expert planner (live testing
// round 5) — off by default, and safe to leave deployed: it only prints
// anything when META_EXPERT_TRACE=1 is set in the environment, and every
// call site below passes an explicit, hand-picked object — never a raw
// plan/context/connection blob — so there's no way for a secret (access
// token, consumer secret, encryption key, password) to end up in here by
// accident of some object growing a new field later. Meant to be removed
// (or just left permanently off) once the live discrepancy this is tracing
// is found and fixed; not a permanent logging feature.
//
// Enable for one request:  META_EXPERT_TRACE=1 (env var on the server
// process), trigger the exact prompt, then read it back out of the
// server's stdout/PM2/systemd logs — every line is prefixed
// "[meta_expert_trace]" for easy grepping.
const ENABLED = process.env.META_EXPERT_TRACE === "1";

export function trace(label, data) {
  if (!ENABLED) return;
  try {
    console.log(`[meta_expert_trace] ${label}: ${JSON.stringify(data)}`);
  } catch (err) {
    console.log(`[meta_expert_trace] ${label}: <failed to serialize: ${err.message}>`);
  }
}

export const traceEnabled = ENABLED;
