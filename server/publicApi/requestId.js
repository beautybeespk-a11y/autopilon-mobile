// Every public API request gets a request ID (Phase 17 §26), set BEFORE
// auth runs so even a 401 response carries one, and echoed back in the
// X-Request-ID header so a developer can hand it to support and it maps
// 1:1 to what api_request_logs recorded for that call.
import crypto from "crypto";

export function requestId(req, res, next) {
  req.requestId = `req_${crypto.randomUUID()}`;
  res.set("X-Request-ID", req.requestId);
  next();
}
