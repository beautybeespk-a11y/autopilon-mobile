// Lightweight diagnostic tracing for Meta Expert V2 — off by default, safe
// to leave deployed. Deliberately independent of server/agents/metaExpert/
// diagnostics.js (V2 does not depend on V1 internals) even though the
// shape is intentionally identical — every call site passes an explicit,
// hand-picked object, never a raw connection/token blob.
const ENABLED = process.env.META_EXPERT_V2_TRACE === "1";

export function trace(label, data) {
  if (!ENABLED) return;
  try {
    console.log(`[meta_expert_v2_trace] ${label}: ${JSON.stringify(data)}`);
  } catch (err) {
    console.log(`[meta_expert_v2_trace] ${label}: <failed to serialize: ${err.message}>`);
  }
}

export const traceEnabled = ENABLED;
