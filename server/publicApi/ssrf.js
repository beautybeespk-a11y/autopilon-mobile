// SSRF protection for developer-configured webhook URLs (Phase 17 §39).
// A webhook URL is the one piece of user input in this whole phase that
// causes OUR server to make an outbound request to an address the
// developer chose — the exact shape of an SSRF vector. Validated at BOTH
// webhook creation time (fail fast, good UX) AND again immediately before
// every delivery attempt (the only check that actually matters for
// security — DNS can change between creation and delivery, a classic
// DNS-rebinding bypass of a creation-time-only check).
import dns from "dns/promises";
import net from "net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// IPv4 ranges that must never be a webhook delivery target: loopback,
// private (RFC1918), link-local (which is ALSO how every major cloud's
// instance-metadata endpoint is reachable — 169.254.169.254 falls right
// inside this range, so blocking link-local blocks metadata SSRF too),
// this-network, and CGNAT shared address space.
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — fail closed
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
  if (a === 0) return true; // "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4 too.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not a recognizable IP — fail closed
}

// err.code = "INVALID" on every rejection here — these are all legitimate,
// safe-to-show-the-developer reasons (never internal detail), and mapping
// to INVALID lets apiErrorFromException() (publicApi/errors.js) surface a
// clear 400 instead of falling through to an opaque generic 500.
function fail(message) {
  const err = new Error(message);
  err.code = "INVALID";
  throw err;
}

// Throws with a clear reason on any disallowed target; resolves silently
// (no return value) if the URL is safe to use RIGHT NOW. Callers must call
// this again immediately before each delivery — never cache "this URL was
// safe an hour ago" as a substitute.
export async function assertSafeWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("Invalid URL.");
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    fail("Webhook URL must use http:// or https://.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    fail("Webhook URL cannot target a local or metadata hostname.");
  }
  // A literal IP in the URL is checked directly; a hostname is resolved and
  // EVERY returned address is checked — DNS can return multiple records,
  // and rejecting only if the first one is private would let a
  // round-robin/rebinding hostname slip through on a later resolution.
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) fail("Webhook URL cannot target a private, loopback, or link-local address.");
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail("Webhook URL's hostname could not be resolved.");
  }
  if (!addresses.length) fail("Webhook URL's hostname could not be resolved.");
  for (const { address } of addresses) {
    if (isPrivateIP(address)) fail("Webhook URL resolves to a private, loopback, or link-local address.");
  }
}
