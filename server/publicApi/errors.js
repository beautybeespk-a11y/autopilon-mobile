// Consistent Public API error format (Phase 17 §27) — every error response
// anywhere under /api/v1 goes through this, never a bare res.status().json()
// with an ad-hoc shape. Never includes a stack trace, DB detail, or
// provider credential — apiError() only ever takes a code + a
// human-written message string, so there is no path for internal detail to
// leak through it by accident.
export function apiError(res, status, code, message) {
  // Stashed on the request so requestLog.js's finish handler can record
  // which error code a failed call actually returned, without requestLog.js
  // having to re-parse the JSON body it already streamed out.
  if (res.req) res.req._apiErrorCode = code;
  res.status(status).json({ error: { code, message, request_id: res.req?.requestId || null } });
}

// Maps the handful of error `code`s already used throughout the existing
// orchestrator layer (QUOTA_EXCEEDED, NOT_FOUND, INVALID, FORBIDDEN, etc.)
// to a public API status code — so route handlers can catch a thrown error
// from an existing service function and translate it in one line instead of
// re-deriving the right status per call site.
const CODE_TO_STATUS = {
  NOT_FOUND: 404,
  INVALID: 400,
  FORBIDDEN: 403,
  QUOTA_EXCEEDED: 429,
  PROVIDER_NOT_CONFIGURED: 503,
  UNAUTHENTICATED: 401,
  FILE_TOO_LARGE: 413,
  FEATURE_DISABLED: 503,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  IDEMPOTENCY_KEY_IN_PROGRESS: 409,
  INTEGRATION_CONTEXT_MISMATCH: 409,
};

export function apiErrorFromException(res, err, fallbackMessage = "Something went wrong.") {
  const status = CODE_TO_STATUS[err.code] || 500;
  const code = err.code || "INTERNAL_ERROR";
  // A real 500 (unexpected, uncategorized) never leaks err.message to the
  // client — that's exactly the "no stack traces / internal detail" rule.
  // Every OTHER status here comes from an error a service function threw
  // on purpose with a message already written to be user-facing.
  const message = status === 500 ? fallbackMessage : err.message;
  apiError(res, status, code, message);
}
