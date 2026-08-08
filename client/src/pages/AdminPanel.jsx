import { useEffect, useState } from "react";
import { Building2, Ticket, FileText, Gift, Plus, DollarSign, ShieldAlert, Flag } from "lucide-react";
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

  const load = () => {
    api.get("/admin/organizations").then(setOrgs).catch(() => {});
    api.get("/admin/plans").then(setPlans).catch(() => {});
    api.get("/admin/coupons").then(setCoupons).catch(() => {});
    api.get("/admin/billing-logs").then(setLogs).catch(() => {});
    api.get("/admin/marketplace/pending").then(setPendingAssets).catch(() => {});
    api.get("/admin/marketplace/reports").then(setReports).catch(() => {});
  };
  useEffect(load, []);

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
