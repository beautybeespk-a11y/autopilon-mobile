// Security headers + CORS policy (Phase 18 §15/§16/§18). Kept in one file
// so the actual header/allowlist values are reviewable in one place rather
// than scattered through index.js's middleware chain.
import helmet from "helmet";

// The web client (client/index.html) loads Google Fonts' stylesheet+font
// files and nothing else external — no other third-party script/style/img/
// connect host anywhere in client/src (verified: no dangerouslySetInnerHTML,
// no EventSource/WebSocket, no external fetch() targets). It uses one
// same-origin <iframe> (Files.jsx, previewing a file's own content URL) and
// blob:/data: URLs for generated audio/image previews and recorded voice
// clips (Chat.jsx, SharedFile.jsx) — both reflected in the directives below.
// upgradeInsecureRequests is added only in production: enabling it in dev
// would make the browser try to upgrade plain-http requests to a dev
// server that has no TLS listener at all, breaking local development.
export function securityHeaders() {
  const isProduction = process.env.NODE_ENV === "production";
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"], // no inline/eval scripts anywhere in the built client
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // React inline `style` attributes require 'unsafe-inline'
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:", "data:"], // recorded voice clips, generated audio/video previews
        connectSrc: ["'self'"],
        frameSrc: ["'self'"], // Files.jsx's own-content-URL preview iframe
        frameAncestors: ["'none'"], // this app is never meant to be embedded by another site
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    // HSTS only makes sense once the app is actually served over HTTPS
    // (production); sending it in dev is harmless to most browsers but
    // there's no reason to — this app has no TLS listener in dev at all.
    hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
}

// Not covered by helmet's own defaults (it deliberately ships no opinion
// here since the right set is always app-specific) — deny every browser
// feature this app doesn't use, allow only what it genuinely does:
// microphone, for Chat.jsx's voice-recording feature (getUserMedia).
export function permissionsPolicy() {
  const policy = [
    "microphone=(self)",
    "camera=()",
    "geolocation=()",
    "payment=()",
    "usb=()",
    "magnetometer=()",
    "gyroscope=()",
    "accelerometer=()",
    "interest-cohort=()",
  ].join(", ");
  return (req, res, next) => {
    res.setHeader("Permissions-Policy", policy);
    next();
  };
}

// CORS (Phase 18 §15): permissive reflect-origin in development (the client
// runs on a different port, :5173, proxied for /api but not for a
// cross-origin dev setup like pointing a mobile emulator or a second
// terminal's curl session straight at :4000) — but an explicit allowlist in
// production, and FAIL CLOSED (no cross-origin credentialed access at all)
// if CLIENT_ORIGIN isn't set, rather than falling back to reflecting
// whatever Origin header showed up. `origin: false` here means the cors
// package never sends Access-Control-Allow-Origin, which is what actually
// blocks a browser from reading the cross-origin response — no CLIENT_ORIGIN
// in production is a configuration gap serious enough that "same-origin
// requests only" is the safer default than "allow anything".
export function corsOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    return { origin: true, credentials: true };
  }
  const allowlist = (process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return { origin: false, credentials: true };
  }
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin browser requests and non-browser clients (curl, mobile app, server-to-server) send no Origin header
      if (allowlist.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  };
}
