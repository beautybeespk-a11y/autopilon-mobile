// Request ID + access logging (Phase 18 §24) — one structured log line per
// completed HTTP request, plus an X-Request-Id response header so a client
// report ("it failed around 2pm") can be tied back to one exact log line.
import { cryptoRandom } from "../middleware.js";
import { logger } from "./logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_INCOMING_ID_LENGTH = 128;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// Honors a caller-supplied X-Request-Id (useful when a request already
// carries one from an upstream proxy/gateway) if it looks like a plausible
// id; otherwise mints a fresh one. Never trusts it blindly — an
// attacker-controlled arbitrarily long or malformed value would otherwise
// flow straight into every log line for this request.
export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const valid = typeof incoming === "string" && incoming.length > 0 && incoming.length <= MAX_INCOMING_ID_LENGTH && SAFE_ID_PATTERN.test(incoming);
    req.requestId = valid ? incoming : cryptoRandom();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  };
}

// orgId shows up in different places depending on which auth layer handled
// the request (session-based internal routes vs. API-key-based Public API
// routes) — this checks every place it's realistically already been set by
// an earlier middleware, without ever reading assumed to work if it hasn't run yet.
function safeOrgId(req) {
  return req.orgId || req.apiKey?.orgId || req.body?.orgId || req.query?.orgId || null;
}

export function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info("request", {
        requestId: req.requestId,
        method: req.method,
        endpoint: req.route ? `${req.baseUrl}${req.route.path}` : req.path,
        statusCode: res.statusCode,
        latencyMs: Date.now() - start,
        userId: req.session?.userId || null,
        orgId: safeOrgId(req),
      });
    });
    next();
  };
}
