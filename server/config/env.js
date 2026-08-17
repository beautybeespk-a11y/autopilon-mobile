// Startup environment validation (Phase 18 §3/§4). Runs once, synchronously,
// before the app starts accepting requests. Never rewrites or defaults a
// production secret on the caller's behalf — it only decides whether to
// proceed (dev) or refuse to boot (prod), and it never logs a secret's
// VALUE, only which variable is missing/insecure.
//
// Three tiers, deliberately not one flat "required" list:
//   - CRITICAL: missing/insecure in production = refuse to boot. These are
//     the vars whose absence doesn't just disable a feature, it corrupts or
//     exposes data (a weak session secret, a missing encryption key that
//     would otherwise throw ENCRYPTION_NOT_CONFIGURED only when a webhook
//     secret is first read back).
//   - RECOMMENDED: missing in production = loud warning, app still boots.
//     Their absence just means one feature area is unavailable (billing,
//     CORS lockdown, a specific integration) — not a correctness or safety
//     issue for everything else.
//   - Everything not listed here is optional in every environment by
//     design (individual AI/search/integration provider keys) — the
//     existing code already handles "this provider isn't configured" as a
//     normal, user-facing state (PROVIDER_NOT_CONFIGURED), not a crash.
const INSECURE_SESSION_SECRET_DEFAULTS = new Set(["dev-insecure-secret", "change-me-to-a-long-random-string"]);

const CRITICAL_IN_PRODUCTION = [
  {
    key: "SESSION_SECRET",
    check: (v) => Boolean(v) && !INSECURE_SESSION_SECRET_DEFAULTS.has(v) && v.length >= 32,
    reason: "must be set to a random string of at least 32 characters (generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\") — a weak or default session secret lets an attacker forge session cookies for any user.",
  },
  {
    key: "BYOK_ENCRYPTION_KEY",
    check: (v) => Boolean(v) && v.length >= 16,
    reason: "must be set — encrypts BYOK provider keys and webhook signing secrets at rest. Without it, those features fail at first use (ENCRYPTION_NOT_CONFIGURED) instead of at boot, which is worse in production.",
  },
];

const RECOMMENDED_IN_PRODUCTION = [
  { key: "CLIENT_ORIGIN", reason: "without it, CORS falls back to reflecting any request Origin (see index.js) — set this to your real frontend origin(s) so production CORS is a real allowlist, not permissive-by-default." },
  { key: "APP_BASE_URL", reason: "used to build webhook/callback URLs shown to users (e.g. Shopify webhook registration) — without it those flows show a blank or wrong URL." },
  { key: "PLATFORM_ADMIN_EMAIL", reason: "without it, no account can ever become a platform admin — the Admin Panel and platform-admin-only routes become permanently unreachable." },
];

function checkAiProviderKey() {
  const provider = process.env.AI_PROVIDER || "anthropic";
  const keyVar = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[provider];
  if (keyVar && !process.env[keyVar]) {
    return `AI_PROVIDER is "${provider}" but ${keyVar} is not set — every agent execution and chat message will fail until it is.`;
  }
  return null;
}

export function validateEnv({ exitOnFailure = true } = {}) {
  const isProduction = process.env.NODE_ENV === "production";
  const failures = [];
  const warnings = [];

  if (isProduction) {
    for (const { key, check, reason } of CRITICAL_IN_PRODUCTION) {
      if (!check(process.env[key])) failures.push(`${key}: ${reason}`);
    }
    for (const { key, reason } of RECOMMENDED_IN_PRODUCTION) {
      if (!process.env[key]) warnings.push(`${key}: ${reason}`);
    }
    const aiWarning = checkAiProviderKey();
    if (aiWarning) warnings.push(aiWarning);
    if ((process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) || (!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET)) {
      warnings.push("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set (or both unset) — billing is only partially configured right now.");
    }
  }

  if (warnings.length) {
    console.warn(`[env] ${warnings.length} recommended production variable(s) missing:`);
    for (const w of warnings) console.warn(`[env]   - ${w}`);
  }

  if (failures.length) {
    console.error(`[env] Refusing to start in production with ${failures.length} critical configuration problem(s):`);
    for (const f of failures) console.error(`[env]   - ${f}`);
    console.error("[env] Set these in your production environment's secret manager (never in a committed file) and restart. See .env.example and DEPLOYMENT_RUNBOOK.md.");
    if (exitOnFailure) process.exit(1);
    return { ok: false, failures, warnings };
  }

  return { ok: true, failures, warnings };
}
