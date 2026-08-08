import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Users, Bot, Zap, Plug, Layers, AlertTriangle, TrendingUp, Clock, DollarSign } from "lucide-react";
import { Card, Badge, Button } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted"><Icon size={16} /><span className="text-xs font-medium">{label}</span></div>
      <div className="mt-2 font-display text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function OrganizationDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [cost, setCost] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get(`/organizations/${id}/dashboard`).then(setDashboard).catch((e) => setError(e.message));
    api.get(`/organizations/${id}/analytics`).then(setAnalytics).catch(() => {});
    api.get(`/organizations/${id}/cost`).then(setCost).catch(() => {});
  }, [id]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!dashboard) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Enterprise Dashboard</h1>
        <p className="mt-1 text-muted">Organization-wide usage, activity, and performance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Members" value={dashboard.members.total} sub={`${dashboard.members.active || 0} active · ${dashboard.members.invited || 0} invited`} />
        <StatCard icon={Bot} label="Agents" value={dashboard.agents.total} sub={`${dashboard.agents.active || 0} active`} />
        <StatCard icon={Zap} label="Automations" value={dashboard.automations.total} sub={`${dashboard.automations.runningNow} running now`} />
        <StatCard icon={Plug} label="Integrations" value={dashboard.connectedIntegrations} sub={`${dashboard.workspaceCount} workspaces`} />
      </div>

      {dashboard.securityAlerts.length > 0 && (
        <Card className="border-amber-400/30 bg-amber-400/5 p-5">
          <div className="flex items-center gap-2"><AlertTriangle size={18} className="text-amber-500" /><h3 className="font-display font-semibold">Security alerts</h3></div>
          <div className="mt-3 space-y-2">
            {dashboard.securityAlerts.map((a, i) => <p key={i} className="text-sm">{a.message}</p>)}
          </div>
        </Card>
      )}

      {cost && (
        <Card className="p-5">
          <div className="flex items-center gap-2"><DollarSign size={18} className="text-accent" /><h3 className="font-display font-semibold">Estimated AI cost</h3></div>
          <p className="mt-1 text-xs text-muted">{cost.note}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <StatCard icon={DollarSign} label={`Last ${cost.periodDays} days (platform-billed)`} value={fmtCents(cost.estimatedCostCents)} />
            <StatCard icon={DollarSign} label="BYOK usage (not billed by us)" value={fmtCents(cost.byokCostCents)} sub="paid directly to your own provider" />
          </div>
          {cost.byProvider.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold">By provider</h4>
              <div className="mt-2 space-y-1">
                {cost.byProvider.map((p) => (
                  <div key={p.provider} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{p.provider}</span>
                    <span className="text-muted">{fmtCents(p.cents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {cost.byAgent.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold">By agent</h4>
              <div className="mt-2 space-y-1">
                {cost.byAgent.slice(0, 5).map((a) => (
                  <div key={a.agentId} className="flex items-center justify-between text-sm">
                    <span>{a.name}</span>
                    <span className="text-muted">{fmtCents(a.cents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {analytics && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard icon={TrendingUp} label="Automation success rate" value={analytics.automationSuccessRate != null ? `${analytics.automationSuccessRate}%` : "—"} sub={`last ${analytics.periodDays} days`} />
            <StatCard icon={Clock} label="Avg response time" value={fmtMs(analytics.avgResponseMs)} sub="across all tool calls" />
          </div>

          <Card className="p-5">
            <h3 className="font-display font-semibold">Most active people</h3>
            <div className="mt-3 space-y-2">
              {analytics.mostActiveUsers.map((u) => (
                <div key={u.id} className="flex items-center justify-between text-sm">
                  <span>{u.name}</span>
                  <span className="text-muted">{u.actions} actions</span>
                </div>
              ))}
              {analytics.mostActiveUsers.length === 0 && <p className="text-sm text-muted">No activity yet in this period.</p>}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-display font-semibold">Most-used agents</h3>
            <div className="mt-3 space-y-2">
              {analytics.mostUsedAgents.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <span>{a.name}</span>
                  <span className="text-muted">{a.messageCount} messages</span>
                </div>
              ))}
              {analytics.mostUsedAgents.length === 0 && <p className="text-sm text-muted">No shared agents used yet.</p>}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-display font-semibold">Workspace activity</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {analytics.workspaceActivity.map((w) => (
                <div key={w.id} className="rounded-xl border border-line p-3">
                  <div className="flex items-center gap-2 font-medium"><Layers size={14} className="text-muted" />{w.name}</div>
                  <div className="mt-2 flex gap-3 text-xs text-muted">
                    <span>{w.agentCount} agents</span>
                    <span>{w.automationCount} automations</span>
                    <span>{w.projectCount} projects</span>
                  </div>
                </div>
              ))}
              {analytics.workspaceActivity.length === 0 && <p className="text-sm text-muted">No workspaces yet.</p>}
            </div>
          </Card>
        </>
      )}

      <Card className="overflow-x-auto p-0">
        <h3 className="p-5 pb-0 font-display font-semibold">Recent activity</h3>
        <table className="mt-3 w-full text-left text-sm">
          <tbody>
            {dashboard.recentActivity.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0">
                <td className="px-5 py-2 text-xs text-muted">{new Date(a.createdAt).toLocaleString()}</td>
                <td className="px-5 py-2">{a.userName}</td>
                <td className="px-5 py-2 font-mono text-xs">{a.action}</td>
                <td className="px-5 py-2"><Badge tone={a.result === "failure" ? "warn" : "success"}>{a.result}</Badge></td>
              </tr>
            ))}
            {dashboard.recentActivity.length === 0 && (
              <tr><td className="px-5 py-6 text-center text-muted">No activity yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-muted">
        AI usage, token consumption, storage, and API usage aren't shown here — this platform doesn't track those yet, so nothing is faked in their place.
      </p>

      <Button variant="outline" onClick={() => navigate(`/app/organizations/${id}`)}>Back to organization</Button>
    </div>
  );
}
