// Public API authentication — API-key-only, deliberately separate from
// middleware.js's requireAuth (session cookie). External developers/machines
// authenticate with a Bearer key, never a browser session; the two are not
// interchangeable and this file never accepts a session as a substitute.
import { authenticateRawKey, hasScope } from "../orchestrator/apiKeyService.js";
import { apiError } from "./errors.js";

export function requireApiKey(req, res, next) {
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return apiError(res, 401, "UNAUTHENTICATED", "Missing or malformed Authorization header. Use: Authorization: Bearer <api_key>.");
  const apiKey = authenticateRawKey(match[1].trim());
  if (!apiKey) return apiError(res, 401, "UNAUTHENTICATED", "Invalid, expired, or revoked API key.");
  req.apiKey = apiKey;
  req.orgId = apiKey.orgId; // every public API route treats this as the tenant boundary — nothing downstream re-derives it another way
  next();
}

// Scope check happens AFTER requireApiKey, as its own middleware, so a
// route's required scope is visible in its own route declaration rather
// than buried in a shared handler — matches least-privilege being an
// explicit, auditable-at-a-glance property of each endpoint.
export function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req.apiKey, scope)) {
      return apiError(res, 403, "INSUFFICIENT_SCOPE", `This API key does not have the "${scope}" scope.`);
    }
    next();
  };
}
