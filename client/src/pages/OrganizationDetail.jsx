import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Building2, UserPlus, Trash2, Ban, RotateCcw, Layers, Plus, BarChart3, Terminal } from "lucide-react";
import { Card, Button, Badge, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const BUILTIN_ROLE_OPTIONS = ["owner", "admin", "manager", "member", "viewer"];

export default function OrganizationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [org, setOrg] = useState(null);
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [orgIntegrations, setOrgIntegrations] = useState([]);
  const [connectingProvider, setConnectingProvider] = useState(null);
  const [connectForm, setConnectForm] = useState({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [auditLogs, setAuditLogs] = useState([]);
  const [billing, setBilling] = useState(null);
  const [plans, setPlans] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [byokForm, setByokForm] = useState({ provider: "anthropic", apiKey: "" });
  const [couponCode, setCouponCode] = useState("");
  const [couponMsg, setCouponMsg] = useState("");
  const [credits, setCredits] = useState(null);
  const [error, setError] = useState("");

  const load = () => {
    api.get(`/organizations/${id}`).then(setOrg).catch((e) => setError(e.message));
    api.get(`/organizations/${id}/members`).then(setMembers).catch(() => {});
    api.get(`/organizations/${id}/roles`).then(setRoles).catch(() => {});
    api.get(`/organizations/${id}/workspaces`).then(setWorkspaces).catch(() => {});
    api.get(`/organizations/${id}/integrations`).then(setOrgIntegrations).catch(() => {});
    api.get(`/organizations/${id}/audit-logs`).then(setAuditLogs).catch(() => setAuditLogs([]));
    api.get(`/organizations/${id}/billing`).then(setBilling).catch(() => {});
    api.get("/plans").then(setPlans).catch(() => {});
    api.get(`/organizations/${id}/api-keys`).then(setApiKeys).catch(() => setApiKeys([]));
    api.get(`/organizations/${id}/credits`).then(setCredits).catch(() => setCredits(null));
  };
  useEffect(load, [id]);

  const canManageMembers = org && ["owner", "admin"].includes(org.myRole);
  const canManageWorkspaces = org && ["owner", "admin"].includes(org.myRole);

  const invite = async () => {
    if (!inviteEmail.trim()) return;
    try {
      await api.post(`/organizations/${id}/members/invite`, { email: inviteEmail, role: inviteRole });
      setInviteEmail(""); load();
    } catch (e) { setError(e.message); }
  };
  const removeMember = async (m) => { await api.del(`/organizations/${id}/members/${m.id}`); load(); };
  const suspendMember = async (m) => { await api.post(`/organizations/${id}/members/${m.id}/suspend`, {}); load(); };
  const reactivateMember = async (m) => { await api.post(`/organizations/${id}/members/${m.id}/reactivate`, {}); load(); };
  const changeRole = async (m, role) => { await api.patch(`/organizations/${id}/members/${m.id}/role`, { role }); load(); };

  const createWorkspace = async () => {
    if (!newWorkspaceName.trim()) return;
    await api.post(`/organizations/${id}/workspaces`, { name: newWorkspaceName });
    setNewWorkspaceName(""); load();
  };
  const removeWorkspace = async (wsId) => { await api.del(`/workspaces/${wsId}`); load(); };

  const toggleWorkspace = async (wsId) => {
    if (expandedWorkspaceId === wsId) { setExpandedWorkspaceId(null); return; }
    setExpandedWorkspaceId(wsId);
    api.get(`/workspaces/${wsId}/projects`).then(setProjects).catch(() => setProjects([]));
  };
  const createProject = async (wsId) => {
    if (!newProjectName.trim()) return;
    await api.post(`/workspaces/${wsId}/projects`, { name: newProjectName });
    setNewProjectName("");
    api.get(`/workspaces/${wsId}/projects`).then(setProjects).catch(() => {});
  };
  const removeProject = async (projectId, wsId) => {
    await api.del(`/projects/${projectId}`);
    api.get(`/workspaces/${wsId}/projects`).then(setProjects).catch(() => {});
  };

  const ORG_INTEGRATION_FIELDS = {
    wordpress: [{ key: "siteUrl", label: "Site URL", placeholder: "https://yourstore.com" }, { key: "username", label: "Username" }, { key: "appPassword", label: "Application password" }],
    woocommerce: [{ key: "siteUrl", label: "Site URL", placeholder: "https://yourstore.com" }, { key: "consumerKey", label: "Consumer key" }, { key: "consumerSecret", label: "Consumer secret" }],
    shopify: [{ key: "shopDomain", label: "Shop domain", placeholder: "yourstore.myshopify.com" }, { key: "accessToken", label: "Admin API access token" }],
  };

  const connectOrgIntegration = async (provider) => {
    await api.post(`/organizations/${id}/integrations/${provider}/connect`, connectForm);
    setConnectingProvider(null); setConnectForm({}); load();
  };
  const disconnectOrgIntegration = async (provider) => {
    await api.post(`/organizations/${id}/integrations/${provider}/disconnect`, {});
    load();
  };

  const upgradePlan = async (planId) => {
    try {
      const { url } = await api.post(`/organizations/${id}/billing/checkout`, { planId });
      window.location.href = url;
    } catch (e) {
      alert(e.message);
    }
  };
  const openBillingPortal = async () => {
    try {
      const { url } = await api.post(`/organizations/${id}/billing/portal`, {});
      window.location.href = url;
    } catch (e) {
      alert(e.message);
    }
  };
  const cancelSubscription = async () => {
    if (!confirm("Cancel this subscription at the end of the current billing period?")) return;
    await api.post(`/organizations/${id}/billing/cancel`, { atPeriodEnd: true });
    api.get(`/organizations/${id}/billing`).then(setBilling).catch(() => {});
  };
  const resumeSubscription = async () => {
    await api.post(`/organizations/${id}/billing/resume`, {});
    api.get(`/organizations/${id}/billing`).then(setBilling).catch(() => {});
  };
  const changeBillingMode = async (mode) => {
    await api.post(`/organizations/${id}/billing/mode`, { billingMode: mode });
    api.get(`/organizations/${id}/billing`).then(setBilling).catch(() => {});
  };
  const saveByokKey = async () => {
    if (!byokForm.apiKey.trim()) return;
    await api.post(`/organizations/${id}/api-keys`, byokForm);
    setByokForm({ ...byokForm, apiKey: "" });
    api.get(`/organizations/${id}/api-keys`).then(setApiKeys).catch(() => {});
  };
  const removeByokKey = async (provider) => {
    await api.del(`/organizations/${id}/api-keys/${provider}`);
    api.get(`/organizations/${id}/api-keys`).then(setApiKeys).catch(() => {});
  };

  const redeemCoupon = async () => {
    if (!couponCode.trim()) return;
    setCouponMsg("");
    try {
      await api.post(`/organizations/${id}/coupons/redeem`, { code: couponCode });
      setCouponMsg("Coupon applied!");
      setCouponCode("");
      api.get(`/organizations/${id}/billing`).then(setBilling).catch(() => {});
    } catch (e) {
      setCouponMsg(e.message);
    }
  };

  if (!org) return error ? <p className="text-red-500">{error}</p> : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent"><Building2 size={22} /></div>
          <div>
            <h1 className="font-display text-2xl font-semibold">{org.name}</h1>
            <p className="text-sm text-muted">Your role: <Badge tone="accent">{org.myRole}</Badge></p>
          </div>
        </div>
        {["owner", "admin"].includes(org.myRole) && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(`/app/organizations/${id}/dashboard`)}><BarChart3 size={16} /> Dashboard</Button>
            <Button variant="outline" onClick={() => navigate(`/app/organizations/${id}/developer`)}><Terminal size={16} /> Developer</Button>
          </div>
        )}
      </div>

      {billing && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display font-semibold">Billing</h3>
              <p className="mt-1 text-sm text-muted">
                Current plan: <Badge tone="accent">{billing.subscription?.plan?.name}</Badge>{" "}
                {billing.subscription?.plan?.monthlyPriceCents ? `$${(billing.subscription.plan.monthlyPriceCents / 100).toFixed(0)}/mo` : "Free"}
                {billing.subscription?.status === "trialing" && billing.subscription?.trialEndsAt && (
                  <> · <Badge tone="warn">Trial ends {new Date(billing.subscription.trialEndsAt).toLocaleDateString()}</Badge></>
                )}
              </p>
            </div>
          </div>

          {canManageMembers && (
            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1"><Input label="Have a coupon code?" value={couponCode} onChange={(e) => setCouponCode(e.target.value)} placeholder="e.g. LAUNCH30" /></div>
              <Button variant="outline" onClick={redeemCoupon}>Redeem</Button>
            </div>
          )}
          {couponMsg && <p className="mt-1 text-xs text-muted">{couponMsg}</p>}

          {canManageMembers && (
            <div className="mt-3 flex flex-wrap gap-2">
              {billing.subscription?.stripeCustomerId && (
                <Button variant="outline" onClick={openBillingPortal}>Manage billing (Stripe)</Button>
              )}
              {billing.subscription?.stripeSubscriptionId && !billing.subscription?.cancelAtPeriodEnd && (
                <Button variant="outline" onClick={cancelSubscription}>Cancel subscription</Button>
              )}
              {billing.subscription?.cancelAtPeriodEnd && (
                <>
                  <Badge tone="warn">Cancels at period end ({new Date(billing.subscription.currentPeriodEnd).toLocaleDateString()})</Badge>
                  <Button variant="outline" onClick={resumeSubscription}>Resume subscription</Button>
                </>
              )}
            </div>
          )}

          {credits && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Account credit</h4>
                <Badge tone={credits.balanceCents > 0 ? "success" : "muted"}>${(credits.balanceCents / 100).toFixed(2)}</Badge>
              </div>
              {credits.history.length > 0 && (
                <div className="mt-2 space-y-1">
                  {credits.history.slice(0, 5).map((c) => (
                    <div key={c.id} className="flex items-center justify-between text-xs text-muted">
                      <span>{c.reason || "Manual credit"} — {c.grantedByName}</span>
                      <span>${(c.amountCents / 100).toFixed(2)}{!c.stripeSynced && " (local only)"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {canManageMembers && (
            <div className="mt-4">
              <span className="mb-2 block text-sm font-medium text-muted">Upgrade or switch plans</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {plans.filter((p) => p.id !== billing.subscription?.planId).map((p) => (
                  <div key={p.id} className="rounded-xl border border-line p-3">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted">{p.monthlyPriceCents ? `$${(p.monthlyPriceCents / 100).toFixed(0)}/mo` : "Free"}</div>
                    <Button
                      className="mt-2 w-full"
                      variant="outline"
                      disabled={!p.stripePriceId && p.monthlyPriceCents > 0}
                      onClick={() => upgradePlan(p.id)}
                    >
                      {p.monthlyPriceCents === 0 ? "Downgrade" : !p.stripePriceId ? "Not available" : "Upgrade"}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canManageMembers && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <div>
                <span className="mb-1.5 block text-sm font-medium text-muted">AI billing mode</span>
                <select
                  value={billing.subscription?.billingMode || "platform_managed"}
                  onChange={(e) => changeBillingMode(e.target.value)}
                  className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm"
                >
                  <option value="platform_managed">Platform-managed AI</option>
                  <option value="byok">Bring your own API keys</option>
                </select>
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {billing.quotas.map((q) => (
              <div key={q.type} className="rounded-xl border border-line p-3">
                <div className="flex items-center justify-between text-sm">
                  <span>{q.type.replace("max", "")} {q.isSoft && <Badge tone="muted">soft limit</Badge>}</span>
                  <span className="text-muted">{q.current} / {q.limit == null ? "∞" : q.limit}</span>
                </div>
                {q.limit != null && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
                    <div
                      className={`h-full rounded-full ${
                        q.percentUsed >= 100 ? "bg-red-500" : q.percentUsed >= 90 ? "bg-amber-500" : q.percentUsed >= 75 ? "bg-amber-400" : q.percentUsed >= 50 ? "bg-accent" : "bg-accent2"
                      }`}
                      style={{ width: `${Math.min(q.percentUsed, 100)}%` }}
                    />
                  </div>
                )}
                {q.warningLevel >= 100 && !q.isSoft && <p className="mt-1 text-xs text-red-500">Limit reached — upgrade to add more.</p>}
                {q.warningLevel >= 100 && q.isSoft && <p className="mt-1 text-xs text-amber-500">Over limit — still working, but consider upgrading.</p>}
                {q.warningLevel && q.warningLevel < 100 && <p className="mt-1 text-xs text-muted">{q.warningLevel}% used this period.</p>}
              </div>
            ))}
          </div>

          {billing.subscription?.billingMode === "byok" && canManageMembers && (
            <div className="mt-4 border-t border-line pt-4">
              <h4 className="text-sm font-semibold">API keys (encrypted at rest)</h4>
              <div className="mt-2 space-y-2">
                {apiKeys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2 text-sm">
                    <span>{k.provider}: {k.masked}</span>
                    <button onClick={() => removeByokKey(k.provider)} className="text-muted hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-end gap-2">
                <select value={byokForm.provider} onChange={(e) => setByokForm({ ...byokForm, provider: e.target.value })} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                </select>
                <div className="flex-1"><Input placeholder="API key" type="password" value={byokForm.apiKey} onChange={(e) => setByokForm({ ...byokForm, apiKey: e.target.value })} /></div>
                <Button onClick={saveByokKey}>Save</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-semibold">Team</h3>
        </div>
        {canManageMembers && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1"><Input label="Invite by email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@example.com" /></div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-muted">Role</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
                {[...BUILTIN_ROLE_OPTIONS.filter((r) => r !== "owner"), ...roles.filter((r) => !r.builtin).map((r) => r.id)].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <Button onClick={invite}><UserPlus size={16} /> Invite</Button>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

        <div className="mt-4 space-y-2">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-xl border border-line p-3">
              <div>
                <div className="font-medium">{m.userName || m.invitedEmail}</div>
                <div className="text-xs text-muted">{m.userEmail || m.invitedEmail} · {m.status}</div>
              </div>
              <div className="flex items-center gap-2">
                {canManageMembers && m.role !== "owner" ? (
                  <select value={m.role} onChange={(e) => changeRole(m, e.target.value)} className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs">
                    {[...BUILTIN_ROLE_OPTIONS.filter((r) => r !== "owner"), ...roles.filter((r) => !r.builtin).map((r) => r.id)].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  <Badge tone="muted">{m.role}</Badge>
                )}
                {canManageMembers && m.role !== "owner" && (
                  <>
                    {m.status === "suspended" ? (
                      <button title="Reactivate" onClick={() => reactivateMember(m)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink"><RotateCcw size={16} /></button>
                    ) : (
                      <button title="Suspend" onClick={() => suspendMember(m)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink"><Ban size={16} /></button>
                    )}
                    <button title="Remove" onClick={() => removeMember(m)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-semibold">Workspaces</h3>
        </div>
        {canManageWorkspaces && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1"><Input label="New workspace" value={newWorkspaceName} onChange={(e) => setNewWorkspaceName(e.target.value)} placeholder="e.g. Marketing" /></div>
            <Button onClick={createWorkspace}><Plus size={16} /> Create</Button>
          </div>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {workspaces.map((w) => (
            <div key={w.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between">
                <button className="flex items-center gap-2" onClick={() => toggleWorkspace(w.id)}>
                  <Layers size={16} className="text-muted" /><span className="font-medium">{w.name}</span>
                </button>
                {canManageWorkspaces && <button onClick={() => removeWorkspace(w.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>}
              </div>
              {expandedWorkspaceId === w.id && (
                <div className="mt-3 space-y-2 border-t border-line pt-3">
                  {canManageWorkspaces && (
                    <div className="flex items-end gap-2">
                      <div className="flex-1"><Input label="New project" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="e.g. Q3 Launch" /></div>
                      <Button onClick={() => createProject(w.id)}>Add</Button>
                    </div>
                  )}
                  {projects.map((p) => (
                    <div key={p.id} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2 text-sm">
                      <span>{p.name}</span>
                      {canManageWorkspaces && <button onClick={() => removeProject(p.id, w.id)} className="text-muted hover:text-red-500"><Trash2 size={14} /></button>}
                    </div>
                  ))}
                  {projects.length === 0 && <p className="text-xs text-muted">No projects yet.</p>}
                </div>
              )}
            </div>
          ))}
          {workspaces.length === 0 && <p className="text-sm text-muted">No workspaces yet.</p>}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-display font-semibold">Integrations</h3>
        <p className="mt-1 text-sm text-muted">Connect once for the whole organization — members with "integrations" permission get access automatically, without connecting individually.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {orgIntegrations.map((it) => (
            <div key={it.provider} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{it.label}</span>
                <Badge tone={it.connected ? "success" : "muted"}>{it.connected ? "Connected" : "Not connected"}</Badge>
              </div>
              {canManageMembers && (
                it.connected ? (
                  <Button variant="outline" className="mt-2 w-full" onClick={() => disconnectOrgIntegration(it.provider)}>Disconnect</Button>
                ) : connectingProvider === it.provider ? (
                  <div className="mt-2 space-y-2">
                    {ORG_INTEGRATION_FIELDS[it.provider].map((f) => (
                      <Input key={f.key} label={f.label} placeholder={f.placeholder} value={connectForm[f.key] || ""} onChange={(e) => setConnectForm({ ...connectForm, [f.key]: e.target.value })} />
                    ))}
                    <div className="flex gap-2">
                      <Button className="flex-1" onClick={() => connectOrgIntegration(it.provider)}>Connect</Button>
                      <Button variant="outline" onClick={() => { setConnectingProvider(null); setConnectForm({}); }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="mt-2 w-full" onClick={() => { setConnectingProvider(it.provider); setConnectForm({}); }}>Connect</Button>
                )
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-display font-semibold">Roles</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {roles.map((r) => (
            <div key={r.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{r.name}</span>
                {r.builtin && <Badge tone="muted">built-in</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {r.permissions.map((p) => <Badge key={p} tone="accent">{p}</Badge>)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {canManageMembers && auditLogs.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <h3 className="p-5 pb-0 font-display font-semibold">Audit Log</h3>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-5 py-2 font-medium">When</th>
                <th className="px-5 py-2 font-medium">Who</th>
                <th className="px-5 py-2 font-medium">Action</th>
                <th className="px-5 py-2 font-medium">Details</th>
                <th className="px-5 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-3 text-xs text-muted">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="px-5 py-3">{l.userName || l.userEmail || l.userId}</td>
                  <td className="px-5 py-3 font-mono text-xs">{l.action}</td>
                  <td className="px-5 py-3 text-muted">{l.description}</td>
                  <td className="px-5 py-3"><Badge tone={l.result === "failure" ? "warn" : "success"}>{l.result}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Button variant="outline" onClick={() => navigate("/app/organizations")}>Back to organizations</Button>
    </div>
  );
}
