import { useEffect, useState } from "react";
import * as Icons from "lucide-react";
import { AlertTriangle, CheckCircle2, Unplug, X } from "lucide-react";
import { Card, Badge, Button, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const ICON = {
  meta_ads: "Megaphone", whatsapp: "MessageCircle", gmail: "Mail", google_calendar: "Calendar", google_drive: "HardDrive",
  google_docs: "FileText", google_sheets: "Table", wordpress: "Globe", woocommerce: "ShoppingCart",
  shopify: "ShoppingBag", slack: "MessageSquare", telegram: "Send",
};

// Field definitions for each manual-connect (non-OAuth) integration. Adding
// a new manual-auth integration later means adding one entry here — the
// form itself is generic.
const MANUAL_FIELDS = {
  whatsapp: [
    { key: "accessToken", label: "Access token", type: "password", placeholder: "System User token", required: true },
    { key: "phoneNumberId", label: "Phone number ID", placeholder: "From Meta dashboard", required: true },
    { key: "wabaId", label: "WhatsApp Business Account ID", placeholder: "Optional" },
    { key: "businessName", label: "Business name", placeholder: "Optional" },
  ],
  wordpress: [
    { key: "siteUrl", label: "Site URL", placeholder: "https://yourstore.com", required: true },
    { key: "username", label: "Username", required: true },
    { key: "appPassword", label: "Application password", type: "password", placeholder: "WP Admin → Users → Application Passwords", required: true },
  ],
  woocommerce: [
    { key: "siteUrl", label: "Site URL", placeholder: "https://yourstore.com", required: true },
    { key: "consumerKey", label: "Consumer key", placeholder: "WooCommerce → Settings → Advanced → REST API", required: true },
    { key: "consumerSecret", label: "Consumer secret", type: "password", required: true },
  ],
  shopify: [
    { key: "shopDomain", label: "Shop domain", placeholder: "yourstore.myshopify.com", required: true },
    { key: "accessToken", label: "Admin API access token", type: "password", placeholder: "Shopify Admin → Settings → Apps and sales channels → Develop apps", required: true },
  ],
};

function readUrlNotice() {
  const params = new URLSearchParams(window.location.search);
  const metaConnected = params.get("meta_connected");
  const metaError = params.get("meta_error");
  const gmailConnected = params.get("gmail_connected");
  const gmailError = params.get("gmail_error");
  if (metaConnected || metaError || gmailConnected || gmailError) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (metaConnected) return { type: "success", message: "Meta Ads connected." };
  if (metaError) return { type: "error", message: metaError };
  if (gmailConnected) return { type: "success", message: "Gmail connected." };
  if (gmailError) return { type: "error", message: gmailError };
  return null;
}

// Generic manual-connect form — driven by MANUAL_FIELDS, so WhatsApp,
// WordPress, and WooCommerce all share one implementation instead of a
// separate hardcoded form per integration.
function ManualConnectForm({ provider, onConnected, onCancel }) {
  const fields = MANUAL_FIELDS[provider] || [];
  const [form, setForm] = useState(Object.fromEntries(fields.map((f) => [f.key, ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const missingRequired = fields.some((f) => f.required && !form[f.key]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      await api.post(`/integrations/${provider}/connect`, form);
      onConnected();
    } catch (err) {
      setError(err.data?.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2.5 rounded-xl border border-line bg-elevated p-3">
      {fields.map((f) => (
        <Input key={f.key} label={f.label} type={f.type || "text"} value={form[f.key]} onChange={set(f.key)} placeholder={f.placeholder} />
      ))}
      {error && <p className="rounded-lg bg-red-500/10 px-2.5 py-2 text-xs text-red-500">{error}</p>}
      <div className="flex gap-2 pt-1">
        <Button className="flex-1" onClick={submit} disabled={busy || missingRequired}>
          {busy ? "Verifying…" : "Connect"}
        </Button>
        <Button variant="outline" onClick={onCancel}><X size={16} /></Button>
      </div>
    </div>
  );
}

export default function Integrations() {
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState(null);

  const load = () => api.get("/integrations").then(setItems).catch(() => {});

  useEffect(() => {
    setNotice(readUrlNotice());
    load();
  }, []);

  const connect = (it) => {
    if (it.setupRequired) return;
    if (it.connectType === "manual") { setConnectingProvider(it.provider); return; }
    window.location.href = it.connectPath; // full navigation — required for the OAuth redirect dance
  };

  const disconnect = async (provider) => {
    setDisconnecting(true);
    try {
      await api.post(`/integrations/${provider === "meta_ads" ? "meta" : provider}/disconnect`, {});
      load();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-muted">Connect the tools your agents work with. Nothing is connected until a real connection is made.</p>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${notice.type === "success" ? "border-accent2/30 bg-accent2/10 text-accent2" : "border-red-500/30 bg-red-500/10 text-red-500"}`}>
          {notice.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {notice.message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          const Icon = Icons[ICON[it.provider]] || Icons.Puzzle;
          const connected = it.status === "connected";
          return (
            <Card key={it.provider} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-elevated text-ink"><Icon size={20} /></div>
                {it.note && <Badge tone="accent">{it.note}</Badge>}
              </div>
              <h3 className="font-display font-semibold">{it.name}</h3>
              <div className="mt-1">
                {connected ? <Badge tone="success">Connected</Badge> : <Badge>Not connected</Badge>}
              </div>
              {connected && it.phoneNumber && <p className="mt-1 text-xs text-muted">{it.phoneNumber}</p>}

              {it.setupRequired && (
                <p className="mt-2 text-xs text-muted">Needs setup by the app owner: {it.setupRequired}</p>
              )}

              <div className="mt-4">
                {!it.available ? (
                  <Button variant="subtle" className="w-full" disabled>Coming soon</Button>
                ) : connected ? (
                  <Button variant="outline" className="w-full" onClick={() => disconnect(it.provider)} disabled={disconnecting}>
                    <Unplug size={16} /> Disconnect
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" onClick={() => connect(it)} disabled={Boolean(it.setupRequired)}>
                    Connect
                  </Button>
                )}
              </div>

              {connectingProvider === it.provider && (
                <ManualConnectForm
                  provider={it.provider}
                  onConnected={() => { setConnectingProvider(null); load(); }}
                  onCancel={() => setConnectingProvider(null)}
                />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
