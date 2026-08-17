import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Key, Webhook, BarChart3, ScrollText, Plus, Trash2, RotateCw, Copy, Eye, EyeOff, Send } from "lucide-react";
import { Card, Button, Badge, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TABS = [
  ["overview", "Overview", BarChart3],
  ["keys", "API Keys", Key],
  ["webhooks", "Webhooks", Webhook],
  ["logs", "Logs", ScrollText],
];

// Shown exactly once at creation/rotation — the whole point of a secret
// reveal card, same principle as every other "copy this now, you won't see
// it again" moment in the app.
function SecretRevealCard({ label, secret, onDone }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card className="border-accent/40 bg-accent/5 p-4">
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="mt-1 text-xs text-muted">Copy this now — it won't be shown again in this form.</p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-line bg-bg px-3 py-2 text-xs">{secret}</code>
        <Button
          variant="outline"
          onClick={() => { navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        >
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Button variant="ghost" className="mt-2" onClick={onDone}>Done</Button>
    </Card>
  );
}

export default function DeveloperConsole() {
  const { id: orgId } = useParams();
  const [tab, setTab] = useState("overview");
  const [scopes, setScopes] = useState([]);
  const [keys, setKeys] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [usage, setUsage] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState([]);
  const [revealedKey, setRevealedKey] = useState(null);

  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookEvents, setNewWebhookEvents] = useState([]);
  const [revealedWebhookSecret, setRevealedWebhookSecret] = useState(null);
  const [visibleSecretFor, setVisibleSecretFor] = useState(null);
  const [deliveriesFor, setDeliveriesFor] = useState(null);
  const [deliveries, setDeliveries] = useState([]);

  const load = () => {
    api.get(`/organizations/${orgId}/developer/scopes`).then((r) => setScopes(r.data)).catch(() => {});
    api.get(`/organizations/${orgId}/developer/api-keys`).then((r) => setKeys(r.data)).catch((e) => setError(e.message));
    api.get(`/organizations/${orgId}/developer/webhooks`).then((r) => setWebhooks(r.data)).catch(() => {});
    api.get(`/organizations/${orgId}/developer/webhooks/event-types`).then((r) => setEventTypes(r.data)).catch(() => {});
    api.get(`/organizations/${orgId}/developer/usage`).then(setUsage).catch(() => {});
    api.get(`/organizations/${orgId}/developer/logs`).then((r) => setLogs(r.data)).catch(() => {});
  };
  useEffect(load, [orgId]);

  const createKey = async () => {
    if (!newKeyName.trim() || !newKeyScopes.length) return alert("Name and at least one scope are required.");
    try {
      const key = await api.post(`/organizations/${orgId}/developer/api-keys`, { name: newKeyName, scopes: newKeyScopes });
      setRevealedKey(key.rawKey);
      setNewKeyName(""); setNewKeyScopes([]);
      load();
    } catch (e) { alert(e.message); }
  };
  const revokeKey = async (keyId) => { if (confirm("Revoke this key? Anything using it will stop working immediately.")) { await api.post(`/organizations/${orgId}/developer/api-keys/${keyId}/revoke`, {}); load(); } };
  const rotateKey = async (keyId) => {
    if (!confirm("Rotate this key? The old secret stops working immediately.")) return;
    const key = await api.post(`/organizations/${orgId}/developer/api-keys/${keyId}/rotate`, {});
    setRevealedKey(key.rawKey);
    load();
  };

  const createWebhook = async () => {
    if (!newWebhookUrl.trim() || !newWebhookEvents.length) return alert("URL and at least one event are required.");
    try {
      const webhook = await api.post(`/organizations/${orgId}/developer/webhooks`, { url: newWebhookUrl, events: newWebhookEvents });
      setRevealedWebhookSecret(webhook.secret);
      setNewWebhookUrl(""); setNewWebhookEvents([]);
      load();
    } catch (e) { alert(e.message); }
  };
  const deleteWebhook = async (webhookId) => { if (confirm("Delete this webhook?")) { await api.del(`/organizations/${orgId}/developer/webhooks/${webhookId}`); load(); } };
  const toggleWebhook = async (webhook) => { await api.patch(`/organizations/${orgId}/developer/webhooks/${webhook.id}`, { status: webhook.status === "active" ? "disabled" : "active" }); load(); };
  const revealWebhookSecret = async (webhookId) => {
    if (visibleSecretFor === webhookId) return setVisibleSecretFor(null);
    const { secret } = await api.get(`/organizations/${orgId}/developer/webhooks/${webhookId}/secret`);
    setVisibleSecretFor(webhookId);
    setWebhooks((prev) => prev.map((w) => (w.id === webhookId ? { ...w, _secret: secret } : w)));
  };
  const testWebhook = async (webhookId) => {
    const result = await api.post(`/organizations/${orgId}/developer/webhooks/${webhookId}/test`, {});
    alert(result.error ? `Delivery failed: ${result.error}` : `Delivered — HTTP ${result.httpStatus} in ${result.responseTimeMs}ms`);
  };
  const viewDeliveries = async (webhookId) => {
    setDeliveriesFor(webhookId);
    const { data } = await api.get(`/organizations/${orgId}/developer/webhooks/${webhookId}/deliveries`);
    setDeliveries(data);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Developer Console</h1>
        <p className="mt-1 text-muted">Manage API keys, webhooks, and monitor Public API usage for this organization.</p>
      </div>

      {error && <Card className="border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</Card>}

      <div className="flex gap-1 border-b border-line pb-px">
        {TABS.map(([key, label, Icon]) => (
          <button
            key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-sm font-medium transition ${tab === key ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated"}`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === "overview" && usage && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              ["Requests", usage.requests, `last ${usage.periodDays}d`],
              ["Errors", usage.errors, `${usage.errorRate}% error rate`],
              ["Avg latency", usage.avgLatencyMs != null ? `${usage.avgLatencyMs}ms` : "—", ""],
              ["Agent executions", usage.agentExecutions.total, `${usage.agentExecutions.failed} failed`],
            ].map(([label, value, sub]) => (
              <Card key={label} className="p-4">
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-1 font-display text-2xl font-semibold">{value}</p>
                {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
              </Card>
            ))}
          </div>
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">Top endpoints</p>
            {usage.topEndpoints.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : (
              <table className="w-full text-left text-sm">
                <thead><tr className="text-xs text-muted"><th className="pb-2">Endpoint</th><th className="pb-2">Requests</th><th className="pb-2">Avg latency</th></tr></thead>
                <tbody>
                  {usage.topEndpoints.map((e, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-2"><code className="text-xs">{e.method} {e.path}</code></td>
                      <td className="py-2">{e.requests}</td>
                      <td className="py-2">{e.avgLatencyMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}

      {tab === "keys" && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">Create a new API key</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1"><Input label="Name" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. Production backend" /></div>
              <Button onClick={createKey}><Plus size={16} /> Create key</Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {scopes.map((s) => (
                <button
                  key={s} onClick={() => setNewKeyScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])}
                  className={`rounded-full border px-2.5 py-1 text-xs ${newKeyScopes.includes(s) ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-elevated"}`}
                >{s}</button>
              ))}
            </div>
          </Card>

          {revealedKey && <SecretRevealCard label="Your new API key" secret={revealedKey} onDone={() => setRevealedKey(null)} />}

          <div className="space-y-2">
            {keys.map((k) => (
              <Card key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{k.name}</p>
                  <p className="text-xs text-muted">{k.keyPrefix}••• · created {new Date(k.createdAt).toLocaleDateString()}{k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}</p>
                  <div className="mt-1 flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={k.status === "active" ? "success" : "muted"}>{k.status}</Badge>
                  {k.status === "active" && (
                    <>
                      <Button variant="outline" onClick={() => rotateKey(k.id)}><RotateCw size={14} /> Rotate</Button>
                      <Button variant="outline" onClick={() => revokeKey(k.id)}><Trash2 size={14} /> Revoke</Button>
                    </>
                  )}
                </div>
              </Card>
            ))}
            {keys.length === 0 && <p className="text-sm text-muted">No API keys yet.</p>}
          </div>
        </div>
      )}

      {tab === "webhooks" && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">Create a new webhook</p>
            <Input label="Endpoint URL" value={newWebhookUrl} onChange={(e) => setNewWebhookUrl(e.target.value)} placeholder="https://yourapp.com/webhooks/autopilon" />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {eventTypes.map((et) => (
                <button
                  key={et} onClick={() => setNewWebhookEvents((prev) => prev.includes(et) ? prev.filter((x) => x !== et) : [...prev, et])}
                  className={`rounded-full border px-2.5 py-1 text-xs ${newWebhookEvents.includes(et) ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-elevated"}`}
                >{et}</button>
              ))}
            </div>
            <Button className="mt-3" onClick={createWebhook}><Plus size={16} /> Create webhook</Button>
          </Card>

          {revealedWebhookSecret && <SecretRevealCard label="Webhook signing secret" secret={revealedWebhookSecret} onDone={() => setRevealedWebhookSecret(null)} />}

          <div className="space-y-2">
            {webhooks.map((w) => (
              <Card key={w.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{w.url}</p>
                    <div className="mt-1 flex flex-wrap gap-1">{w.events.map((e) => <Badge key={e}>{e}</Badge>)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={w.status === "active" ? "success" : "muted"}>{w.status}</Badge>
                    <Button variant="outline" onClick={() => revealWebhookSecret(w.id)}>{visibleSecretFor === w.id ? <EyeOff size={14} /> : <Eye size={14} />} Secret</Button>
                    <Button variant="outline" onClick={() => testWebhook(w.id)}><Send size={14} /> Test</Button>
                    <Button variant="outline" onClick={() => viewDeliveries(w.id)}>Deliveries</Button>
                    <Button variant="outline" onClick={() => toggleWebhook(w)}>{w.status === "active" ? "Disable" : "Enable"}</Button>
                    <Button variant="outline" onClick={() => deleteWebhook(w.id)}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {visibleSecretFor === w.id && w._secret && (
                  <code className="mt-3 block rounded-lg border border-line bg-bg px-3 py-2 text-xs">{w._secret}</code>
                )}
                {deliveriesFor === w.id && (
                  <div className="mt-3 border-t border-line pt-3">
                    {deliveries.length === 0 ? <p className="text-xs text-muted">No deliveries yet.</p> : (
                      <table className="w-full text-left text-xs">
                        <thead><tr className="text-muted"><th className="pb-1">Event</th><th className="pb-1">Status</th><th className="pb-1">HTTP</th><th className="pb-1">Latency</th><th className="pb-1">When</th></tr></thead>
                        <tbody>
                          {deliveries.map((d) => (
                            <tr key={d.id} className="border-t border-line/50">
                              <td className="py-1">{d.eventType}</td>
                              <td className="py-1"><Badge tone={d.status === "completed" ? "success" : d.status === "failed" || d.status === "dead_letter" ? "warn" : "muted"}>{d.status}</Badge></td>
                              <td className="py-1">{d.httpStatus ?? "—"}</td>
                              <td className="py-1">{d.responseTimeMs != null ? `${d.responseTimeMs}ms` : "—"}</td>
                              <td className="py-1">{new Date(d.createdAt).toLocaleTimeString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </Card>
            ))}
            {webhooks.length === 0 && <p className="text-sm text-muted">No webhooks yet.</p>}
          </div>
        </div>
      )}

      {tab === "logs" && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Recent API requests</p>
          {logs.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : (
            <table className="w-full text-left text-sm">
              <thead><tr className="text-xs text-muted"><th className="pb-2">Method</th><th className="pb-2">Path</th><th className="pb-2">Status</th><th className="pb-2">Latency</th><th className="pb-2">When</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className="py-2"><code className="text-xs">{l.method}</code></td>
                    <td className="py-2"><code className="text-xs">{l.path}</code></td>
                    <td className="py-2"><Badge tone={l.statusCode >= 400 ? "warn" : "success"}>{l.statusCode}</Badge></td>
                    <td className="py-2">{l.latencyMs}ms</td>
                    <td className="py-2 text-xs text-muted">{new Date(l.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
