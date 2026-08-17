import { useEffect, useState } from "react";
import { Building2, Ticket, FileText, Gift, Plus, DollarSign, ShieldAlert, Flag, Activity, ToggleLeft, Trash2, History } from "lucide-react";
import { Card, Button, Badge, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

function fmtCents(cents) {
  return cents ? `$${(cents / 100).toFixed(0)}` : "Free";
}

export default function AdminPanel() {
  const [orgs, setOrgs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [coupons, setCoupons] = useState([]);
  const [logs, setLogs] = useState([]);
  const [editingPlan, setEditingPlan] = useState(null);
  const [couponForm, setCouponForm] = useState({ code: "", type: "trial", value: "", targetPlanId: "", maxRedemptions: "" });
  const [trialForm, setTrialForm] = useState({ orgId: "", planId: "", days: "14" });
  const [creditForm, setCreditForm] = useState({ orgId: "", amount: "", reason: "" });
  const [pendingAssets, setPendingAssets] = useState([]);
  const [reports, setReports] = useState([]);
  const [rejectReasons, setRejectReasons] = useState({});
  const [apiUsage, setApiUsage] = useState(null);
  const [flags, setFlags] = useState([]);
  const [flagAuditLog, setFlagAuditLog] = useState([]);
  const [newFlagForm, setNewFlagForm] = useState({ key: "", name: "", description: "", enabled: true, rolloutPercent: "100" });
  const [overrideDrafts, setOverrideDrafts] = useState({}); // flagKey -> { scopeType, scopeId }

  const load = () => {
    api.get("/admin/organizations").then(setOrgs).catch(() => {});
    api.get("/admin/plans").then(setPlans).catch(() => {});
    api.get("/admin/coupons").then(setCoupons).catch(() => {});
    api.get("/admin/billing-logs").then(setLogs).catch(() => {});
    api.get("/admin/marketplace/pending").then(setPendingAssets).catch(() => {});
    api.get("/admin/marketplace/reports").then(setReports).catch(() => {});
    api.get("/admin/api-usage?sinceDays=7").then(setApiUsage).catch(() => {});
    api.get("/admin/feature-flags").then(setFlags).catch(() => {});
    api.get("/admin/feature-flags/audit-log?limit=30").then(setFlagAuditLog).catch(() => {});
  };
  useEffect(load, []);

  const createFlag = async () => {
    if (!newFlagForm.key.trim() || !newFlagForm.name.trim()) return;
    await api.post("/admin/feature-flags", { ...newFlagForm, rolloutPercent: Number(newFlagForm.rolloutPercent) || 100 });
    setNewFlagForm({ key: "", name: "", description: "", enabled: true, rolloutPercent: "100" });
    load();
  };
  const toggleFlag = async (flag) => { await api.patch(`/admin/feature-flags/${flag.key}`, { enabled: !flag.enabled }); load(); };
  const emergencyDisableFlag = async (key) => {
    if (!confirm(`Emergency-disable "${key}" right now? This overrides its rollout percentage and takes effect immediately.`)) return;
    await api.post(`/admin/feature-flags/${key}/disable`, {});
    load();
  };
  const updateRollout = async (key, rolloutPercent) => { await api.patch(`/admin/feature-flags/${key}`, { rolloutPercent }); load(); };
  const deleteFlag = async (key) => {
    if (!confirm(`Delete flag "${key}"? Any code checking this flag will treat it as unknown (always off). This cannot be undone.`)) return;
    await api.del(`/admin/feature-flags/${key}`);
    load();
  };
  const addOverride = async (flagKey) => {
    const draft = overrideDrafts[flagKey];
    if (!draft?.scopeId?.trim()) return;
    await api.post(`/admin/feature-flags/${flagKey}/overrides`, { scopeType: draft.scopeType || "org", scopeId: draft.scopeId.trim(), enabled: draft.enabled ?? true });
    setOverrideDrafts({ ...overrideDrafts, [flagKey]: { scopeType: draft.scopeType || "org", scopeId: "", enabled: true } });
    load();
  };
  const removeOverride = async (flagKey, scopeType, scopeId) => { await api.del(`/admin/feature-flags/${flagKey}/overrides/${scopeType}/${scopeId}`); load(); };

  const approveAsset = async (id) => { await api.post(`/admin/marketplace/assets/${id}/approve`, {}); load(); };
  const rejectAsset = async (id) => {
    await api.post(`/admin/marketplace/assets/${id}/reject`, { reason: rejectReasons[id] || "" });
    setRejectReasons({ ...rejectReasons, [id]: "" });
    load();
  };
  const resolveReport = async (id, action) => { await api.post(`/admin/marketplace/reports/${id}/resolve`, { action }); load(); };

  const savePlan = async () => {
    await api.patch(`/admin/plans/${editingPlan.id}`, editingPlan);
    setEditingPlan(null);
    load();
  };

  const createCoupon = async () => {
    if (!couponForm.code.trim() || !couponForm.value) return;
    await api.post("/admin/coupons", {
      ...couponForm,
      value: Number(couponForm.value),
      maxRedemptions: couponForm.maxRedemptions ? Number(couponForm.maxRedemptions) : undefined,
      targetPlanId: couponForm.targetPlanId || undefined,
    });
    setCouponForm({ code: "", type: "trial", value: "", targetPlanId: "", maxRedemptions: "" });
    load();
  };
  const deactivateCoupon = async (id) => {
    await api.post(`/admin/coupons/${id}/deactivate`, {});
    load();
  };

  const grantTrial = async () => {
    if (!trialForm.orgId || !trialForm.planId) return;
    await api.post(`/admin/organizations/${trialForm.orgId}/grant-trial`, { planId: trialForm.planId, days: Number(trialForm.days) });
    setTrialForm({ orgId: "", planId: "", days: "14" });
    load();
  };

  const grantCredit = async () => {
    if (!creditForm.orgId || !creditForm.amount) return;
    await api.post(`/admin/organizations/${creditForm.orgId}/credits`, { amountCents: Math.round(Number(creditForm.amount) * 100), reason: creditForm.reason });
    setCreditForm({ orgId: "", amount: "", reason: "" });
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Admin Panel</h1>
        <p className="mt-1 text-muted">Platform-wide organization, plan, and billing management.</p>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2"><Building2 size={18} className="text-accent" /><h3 className="font-display font-semibold">Organizations</h3></div>
        <table className="mt-3 w-full text-left text-sm">
          <thead><tr className="border-b border-line text-xs text-muted">
            <th className="py-2 font-medium">Name</th><th className="py-2 font-medium">Owner</th>
            <th className="py-2 font-medium">Plan</th><th className="py-2 font-medium">Members</th><th className="py-2 font-medium">Status</th>
          </tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="py-2">{o.name}</td>
                <td className="py-2 text-muted">{o.ownerName}</td>
                <td className="py-2"><Badge tone="accent">{o.planId}</Badge></td>
                <td className="py-2">{o.memberCount}</td>
                <td className="py-2"><Badge tone={o.subscriptionStatus === "trialing" ? "warn" : "success"}>{o.subscriptionStatus}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><Activity size={18} className="text-accent" /><h3 className="font-display font-semibold">Public API usage (last {apiUsage?.periodDays ?? 7}d, all organizations)</h3></div>
        {apiUsage ? (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Requests", apiUsage.requests],
                ["Errors", apiUsage.errors, `${apiUsage.errorRate}% error rate`],
                ["Avg latency", apiUsage.avgLatencyMs != null ? `${apiUsage.avgLatencyMs}ms` : "—"],
                ["Rate-limit events", apiUsage.rateLimitEvents],
                ["Active API keys", apiUsage.activeApiKeys],
                ["Active webhooks", apiUsage.activeWebhooks],
              ].map(([label, value, sub]) => (
                <div key={label} className="rounded-xl border border-line p-3">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="mt-1 font-display text-xl font-semibold">{value}</p>
                  {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
                </div>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-medium">Top endpoints</p>
                {apiUsage.topEndpoints.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : (
                  <table className="w-full text-left text-xs">
                    <thead><tr className="text-muted"><th className="pb-1">Endpoint</th><th className="pb-1">Requests</th><th className="pb-1">Avg latency</th></tr></thead>
                    <tbody>
                      {apiUsage.topEndpoints.slice(0, 10).map((e, i) => (
                        <tr key={i} className="border-t border-line/50">
                          <td className="py-1"><code>{e.method} {e.path}</code></td>
                          <td className="py-1">{e.requests}</td>
                          <td className="py-1">{e.avgLatencyMs != null ? `${e.avgLatencyMs}ms` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Top organizations by requests</p>
                {apiUsage.topOrganizations.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : (
                  <table className="w-full text-left text-xs">
                    <thead><tr className="text-muted"><th className="pb-1">Organization</th><th className="pb-1">Requests</th><th className="pb-1">Errors</th></tr></thead>
                    <tbody>
                      {apiUsage.topOrganizations.slice(0, 10).map((o) => (
                        <tr key={o.orgId} className="border-t border-line/50">
                          <td className="py-1">{o.orgName}</td>
                          <td className="py-1">{o.requests}</td>
                          <td className="py-1">{o.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Errors by code</p>
                {apiUsage.errorsByCode.length === 0 ? <p className="text-sm text-muted">No errors in this period.</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {apiUsage.errorsByCode.map((e) => (
                      <Badge key={e.errorCode} tone="warn">{e.errorCode} · {e.count}</Badge>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Webhook deliveries by status</p>
                {apiUsage.webhookDeliveriesByStatus.length === 0 ? <p className="text-sm text-muted">No webhook deliveries in this period.</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {apiUsage.webhookDeliveriesByStatus.map((s) => (
                      <Badge key={s.status} tone={s.status === "completed" ? "success" : s.status === "failed" || s.status === "dead_letter" ? "warn" : "muted"}>{s.status} · {s.count}</Badge>
                    ))}
                  </div>
                )}
                {apiUsage.topOrgsByWebhookFailures.length > 0 && (
                  <table className="mt-2 w-full text-left text-xs">
                    <thead><tr className="text-muted"><th className="pb-1">Organization</th><th className="pb-1">Failed deliveries</th></tr></thead>
                    <tbody>
                      {apiUsage.topOrgsByWebhookFailures.slice(0, 10).map((o) => (
                        <tr key={o.orgId} className="border-t border-line/50">
                          <td className="py-1">{o.orgName}</td>
                          <td className="py-1">{o.failures}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        ) : <p className="mt-3 text-sm text-muted">Loading…</p>}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><ToggleLeft size={18} className="text-accent" /><h3 className="font-display font-semibold">Feature flags</h3></div>
        <p className="mt-1 text-xs text-muted">Global switches for risky or staged-rollout features (including the Public API's per-resource gates) — reuses the same engine every flag in the platform is evaluated against. Changes take effect immediately, no redeploy.</p>

        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line p-3">
          <div className="w-40"><Input label="Key" value={newFlagForm.key} onChange={(e) => setNewFlagForm({ ...newFlagForm, key: e.target.value })} placeholder="my_new_flag" /></div>
          <div className="w-48"><Input label="Name" value={newFlagForm.name} onChange={(e) => setNewFlagForm({ ...newFlagForm, name: e.target.value })} placeholder="My New Flag" /></div>
          <div className="flex-1 min-w-[160px]"><Input label="Description" value={newFlagForm.description} onChange={(e) => setNewFlagForm({ ...newFlagForm, description: e.target.value })} placeholder="What this controls" /></div>
          <div className="w-24"><Input label="Rollout %" type="number" min="0" max="100" value={newFlagForm.rolloutPercent} onChange={(e) => setNewFlagForm({ ...newFlagForm, rolloutPercent: e.target.value })} /></div>
          <label className="flex items-center gap-1.5 pb-2.5 text-sm text-muted">
            <input type="checkbox" checked={newFlagForm.enabled} onChange={(e) => setNewFlagForm({ ...newFlagForm, enabled: e.target.checked })} /> Enabled
          </label>
          <Button onClick={createFlag}><Plus size={16} /> Create flag</Button>
        </div>

        <div className="mt-4 space-y-3">
          {flags.map((flag) => (
            <div key={flag.key} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{flag.name}</span>
                    <code className="text-xs text-muted">{flag.key}</code>
                    <Badge tone={flag.enabled ? "success" : "muted"}>{flag.enabled ? "enabled" : "disabled"}</Badge>
                  </div>
                  {flag.description && <p className="mt-0.5 text-xs text-muted">{flag.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-20"><Input type="number" min="0" max="100" defaultValue={flag.rolloutPercent} onBlur={(e) => { const v = Number(e.target.value); if (v !== flag.rolloutPercent) updateRollout(flag.key, v); }} /></div>
                  <span className="text-xs text-muted">% rollout</span>
                  <Button variant="outline" onClick={() => toggleFlag(flag)}>{flag.enabled ? "Disable" : "Enable"}</Button>
                  <Button variant="outline" onClick={() => emergencyDisableFlag(flag.key)}>Emergency disable</Button>
                  <Button variant="outline" onClick={() => deleteFlag(flag.key)}><Trash2 size={14} /></Button>
                </div>
              </div>

              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-2 text-xs font-medium text-muted">Organization / user overrides</p>
                <div className="flex flex-wrap gap-1.5">
                  {flag.overrides.length === 0 && <span className="text-xs text-muted">No overrides.</span>}
                  {flag.overrides.map((o) => (
                    <Badge key={`${o.scopeType}:${o.scopeId}`} tone={o.enabled ? "success" : "warn"}>
                      {o.scopeType}:{o.scopeId} → {o.enabled ? "on" : "off"}
                      <button className="ml-1.5 opacity-70 hover:opacity-100" onClick={() => removeOverride(flag.key, o.scopeType, o.scopeId)} title="Remove override">×</button>
                    </Badge>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <select
                    value={overrideDrafts[flag.key]?.scopeType || "org"}
                    onChange={(e) => setOverrideDrafts({ ...overrideDrafts, [flag.key]: { ...overrideDrafts[flag.key], scopeType: e.target.value } })}
                    className="rounded-xl border border-line bg-surface px-3 py-2 text-xs"
                  >
                    <option value="org">org</option>
                    <option value="user">user</option>
                  </select>
                  <div className="w-40"><Input placeholder="org or user id" value={overrideDrafts[flag.key]?.scopeId || ""} onChange={(e) => setOverrideDrafts({ ...overrideDrafts, [flag.key]: { ...overrideDrafts[flag.key], scopeId: e.target.value } })} /></div>
                  <label className="flex items-center gap-1.5 pb-2.5 text-xs text-muted">
                    <input type="checkbox" checked={overrideDrafts[flag.key]?.enabled ?? true} onChange={(e) => setOverrideDrafts({ ...overrideDrafts, [flag.key]: { ...overrideDrafts[flag.key], enabled: e.target.checked } })} /> Enabled
                  </label>
                  <Button variant="outline" onClick={() => addOverride(flag.key)}>Add override</Button>
                </div>
              </div>
            </div>
          ))}
          {flags.length === 0 && <p className="text-sm text-muted">No feature flags yet.</p>}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <div className="flex items-center gap-2"><History size={14} className="text-muted" /><p className="text-xs font-medium text-muted">Recent changes</p></div>
          <div className="mt-2 max-h-64 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {flagAuditLog.map((l) => (
                  <tr key={l.id} className="border-t border-line/50">
                    <td className="py-1.5 pr-3 text-muted">{new Date(l.createdAt).toLocaleString()}</td>
                    <td className="py-1.5 pr-3">{l.userName || "—"}</td>
                    <td className="py-1.5 pr-3 font-mono">{l.action}</td>
                    <td className="py-1.5 text-muted">{l.description}</td>
                  </tr>
                ))}
                {flagAuditLog.length === 0 && <tr><td className="py-3 text-center text-muted">No changes yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><Gift size={18} className="text-accent" /><h3 className="font-display font-semibold">Grant a manual trial</h3></div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <select value={trialForm.orgId} onChange={(e) => setTrialForm({ ...trialForm, orgId: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="">Select organization</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <select value={trialForm.planId} onChange={(e) => setTrialForm({ ...trialForm, planId: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="">Select plan</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="w-24"><Input label="Days" type="number" value={trialForm.days} onChange={(e) => setTrialForm({ ...trialForm, days: e.target.value })} /></div>
          <Button onClick={grantTrial}>Grant</Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><DollarSign size={18} className="text-accent" /><h3 className="font-display font-semibold">Grant account credit</h3></div>
        <p className="mt-1 text-xs text-muted">Applied as a real Stripe Customer Balance transaction (reduces their next invoice) when Stripe is connected — otherwise recorded locally only.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <select value={creditForm.orgId} onChange={(e) => setCreditForm({ ...creditForm, orgId: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="">Select organization</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <div className="w-28"><Input label="Amount ($)" type="number" value={creditForm.amount} onChange={(e) => setCreditForm({ ...creditForm, amount: e.target.value })} placeholder="25.00" /></div>
          <div className="flex-1"><Input label="Reason" value={creditForm.reason} onChange={(e) => setCreditForm({ ...creditForm, reason: e.target.value })} placeholder="Service credit for outage" /></div>
          <Button onClick={grantCredit}>Grant credit</Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><Ticket size={18} className="text-accent" /><h3 className="font-display font-semibold">Coupons</h3></div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-32"><Input label="Code" value={couponForm.code} onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value })} placeholder="LAUNCH30" /></div>
          <select value={couponForm.type} onChange={(e) => setCouponForm({ ...couponForm, type: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="trial">Trial (days)</option>
            <option value="percent_discount">Percent discount</option>
            <option value="fixed_discount">Fixed discount (cents)</option>
          </select>
          <div className="w-24"><Input label="Value" type="number" value={couponForm.value} onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} /></div>
          {couponForm.type === "trial" && (
            <select value={couponForm.targetPlanId} onChange={(e) => setCouponForm({ ...couponForm, targetPlanId: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
              <option value="">Current plan</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <div className="w-28"><Input label="Max uses" type="number" value={couponForm.maxRedemptions} onChange={(e) => setCouponForm({ ...couponForm, maxRedemptions: e.target.value })} placeholder="∞" /></div>
          <Button onClick={createCoupon}><Plus size={16} /> Create</Button>
        </div>
        <div className="mt-4 space-y-2">
          {coupons.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2 text-sm">
              <span>
                <span className="font-mono font-semibold">{c.code}</span> — {c.type} {c.type === "trial" ? `${c.value}d` : c.type === "percent_discount" ? `${c.value}%` : fmtCents(c.value)}
                {" · "}{c.redemptionCount}{c.maxRedemptions ? `/${c.maxRedemptions}` : ""} used
              </span>
              <div className="flex items-center gap-2">
                <Badge tone={c.active ? "success" : "muted"}>{c.active ? "active" : "inactive"}</Badge>
                {c.active && <Button variant="outline" onClick={() => deactivateCoupon(c.id)}>Deactivate</Button>}
              </div>
            </div>
          ))}
          {coupons.length === 0 && <p className="text-sm text-muted">No coupons yet.</p>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><ShieldAlert size={18} className="text-accent" /><h3 className="font-display font-semibold">Marketplace: pending review ({pendingAssets.length})</h3></div>
        <div className="mt-3 space-y-3">
          {pendingAssets.map((a) => (
            <div key={a.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted">by {a.creatorName}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{a.description}</p>
              <div className="mt-2 flex items-end gap-2">
                <div className="flex-1"><Input placeholder="Reason if rejecting" value={rejectReasons[a.id] || ""} onChange={(e) => setRejectReasons({ ...rejectReasons, [a.id]: e.target.value })} /></div>
                <Button onClick={() => approveAsset(a.id)}>Approve</Button>
                <Button variant="outline" onClick={() => rejectAsset(a.id)}>Reject</Button>
              </div>
            </div>
          ))}
          {pendingAssets.length === 0 && <p className="text-sm text-muted">Nothing pending review.</p>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><Flag size={18} className="text-accent" /><h3 className="font-display font-semibold">Open abuse reports ({reports.length})</h3></div>
        <div className="mt-3 space-y-3">
          {reports.map((r) => (
            <div key={r.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{r.assetName}</span>
                <span className="text-xs text-muted">reported by {r.reporterName}</span>
              </div>
              <p className="mt-1 text-sm">{r.reason}</p>
              {r.details && <p className="mt-1 text-sm text-muted">{r.details}</p>}
              <div className="mt-2 flex gap-2">
                <Button variant="outline" onClick={() => resolveReport(r.id, "resolved")}>Mark resolved</Button>
                <Button variant="outline" onClick={() => resolveReport(r.id, "dismissed")}>Dismiss</Button>
              </div>
            </div>
          ))}
          {reports.length === 0 && <p className="text-sm text-muted">No open reports.</p>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><FileText size={18} className="text-accent" /><h3 className="font-display font-semibold">Plans</h3></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <div key={p.id} className="rounded-xl border border-line p-3">
              {editingPlan?.id === p.id ? (
                <div className="space-y-2">
                  <Input label="Monthly price (cents)" type="number" value={editingPlan.monthlyPriceCents} onChange={(e) => setEditingPlan({ ...editingPlan, monthlyPriceCents: Number(e.target.value) })} />
                  <Input label="Max agents" type="number" value={editingPlan.maxAgents ?? ""} onChange={(e) => setEditingPlan({ ...editingPlan, maxAgents: e.target.value === "" ? null : Number(e.target.value) })} />
                  <Input label="Max AI requests" type="number" value={editingPlan.maxAiRequests ?? ""} onChange={(e) => setEditingPlan({ ...editingPlan, maxAiRequests: e.target.value === "" ? null : Number(e.target.value) })} />
                  <Input label="Stripe Price ID" value={editingPlan.stripePriceId || ""} onChange={(e) => setEditingPlan({ ...editingPlan, stripePriceId: e.target.value })} placeholder="price_..." />
                  <p className="text-xs text-muted">Required for org owners to check out on this plan — from dashboard.stripe.com/products</p>
                  <div className="flex gap-2">
                    <Button onClick={savePlan}>Save</Button>
                    <Button variant="outline" onClick={() => setEditingPlan(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.name}</span>
                    <Button variant="outline" onClick={() => setEditingPlan(p)}>Edit</Button>
                  </div>
                  <p className="mt-1 text-sm text-muted">{fmtCents(p.monthlyPriceCents)}/mo</p>
                  <p className="mt-1 text-xs text-muted">Agents: {p.maxAgents ?? "∞"} · AI requests: {p.maxAiRequests ?? "∞"}/mo</p>
                  {p.monthlyPriceCents > 0 && (
                    <p className="mt-1 text-xs">{p.stripePriceId ? <span className="text-accent2">✓ Checkout ready</span> : <span className="text-amber-500">⚠ No Stripe Price ID set</span>}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <h3 className="p-5 pb-0 font-display font-semibold">Billing activity (all organizations)</h3>
        <table className="mt-3 w-full text-left text-sm">
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="px-5 py-2 text-xs text-muted">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="px-5 py-2">{l.orgName || "—"}</td>
                <td className="px-5 py-2">{l.userName}</td>
                <td className="px-5 py-2 font-mono text-xs">{l.action}</td>
                <td className="px-5 py-2 text-muted">{l.description}</td>
              </tr>
            ))}
            {logs.length === 0 && <tr><td className="px-5 py-6 text-center text-muted">No billing activity yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
