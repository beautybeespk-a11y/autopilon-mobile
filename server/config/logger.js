// Structured logging (Phase 18 §24) — one JSON line per event to stdout
// (info/debug) or stderr (warn/error), the shape any real log aggregator
// (CloudWatch, Datadog, a `docker logs | jq` pipeline) expects. Replaces
// ad-hoc console.log/console.error calls in new Phase 18 code; existing
// call sites are left alone (not a rewrite of working code, per Phase 18's
// rules) but can adopt this incrementally.
//
// Fields, only included when the caller actually has them (never guessed):
// timestamp, level, service, message, requestId, orgId, userId, jobId,
// agentId, endpoint, latencyMs, errorCode — plus whatever else a specific
// call site passes in `context`.
//
// NEVER pass: password, token, secret, apiKey/api_key, authorization,
// cookie, or a full file body/AI prompt payload as a field. redact() below
// is a defense-in-depth safety net (strips anything whose key matches a
// sensitive-looking pattern before it's ever serialized) — it is not a
// substitute for not logging that data in the first place.
const SENSITIVE_KEY_PATTERN = /password|token|secret|apikey|api_key|authorization|cookie|encryptionkey/i;

function redact(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const SERVICE = process.env.LOG_SERVICE_NAME || "api";

function write(level, message, context, stream) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    message,
    ...redact(context || {}),
  };
  stream.write(JSON.stringify(line) + "\n");
}

export const logger = {
  info: (message, context) => write("info", message, context, process.stdout),
  warn: (message, context) => write("warn", message, context, process.stderr),
  error: (message, context) => write("error", message, context, process.stderr),
  debug: (message, context) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", message, context, process.stdout);
  },
};
