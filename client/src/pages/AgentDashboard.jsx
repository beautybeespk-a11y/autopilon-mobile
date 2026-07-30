import { useEffect, useState } from "react";
import { Bot, MessageSquare, Wrench, Zap, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Card, Badge } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtDate(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted"><Icon size={16} /><span className="text-xs font-medium">{label}</span></div>
      <div className="mt-2 font-display text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

export default function AgentDashboard() {
  const [data, setData] = useState(null);

  useEffect(() => { api.get("/dashboard/agents").then(setData).catch(() => {}); }, []);

  if (!data) return null;
  const { summary, agents } = data;
  const successRate = summary.toolCalls.total ? Math.round((summary.toolCalls.succeeded / summary.toolCalls.total) * 100) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Agent Dashboard</h1>
        <p className="mt-1 text-muted">Usage and performance across all your agents.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Bot} label="Agents" value={summary.totalAgents} sub={`${summary.activeAgents} active · ${summary.inactiveAgents} inactive`} />
        <StatCard icon={MessageSquare} label="Conversations" value={summary.totalConversations} sub={`${summary.totalMessages} messages`} />
        <StatCard icon={Wrench} label="Tool calls" value={summary.toolCalls.total} sub={successRate != null ? `${successRate}% succeeded` : "—"} />
        <StatCard icon={Clock} label="Avg response time" value={fmtMs(summary.avgResponseMs)} sub="across all tool calls" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard icon={Zap} label="Active automations" value={summary.activeAutomations} sub={`${summary.automationRunsThisWeek} events this week`} />
        <StatCard
          icon={summary.toolCalls.failed > 0 ? XCircle : CheckCircle2}
          label="Tool call outcomes"
          value={`${summary.toolCalls.succeeded} / ${summary.toolCalls.failed}`}
          sub="succeeded / failed"
        />
      </div>

      {summary.topToolsOverall?.length > 0 && (
        <Card className="p-5">
          <h3 className="font-display font-semibold">Most-used tools</h3>
          <div className="mt-3 space-y-2">
            {summary.topToolsOverall.map((t) => {
              const max = summary.topToolsOverall[0].c;
              return (
                <div key={t.toolName} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm">{t.toolName}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max((t.c / max) * 100, 4)}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs text-muted">{t.c}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <h3 className="p-5 pb-0 font-display font-semibold">Agent performance</h3>
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="px-5 py-2 font-medium">Agent</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium">Conversations</th>
              <th className="px-5 py-2 font-medium">Messages</th>
              <th className="px-5 py-2 font-medium">Tool calls</th>
              <th className="px-5 py-2 font-medium">Avg response</th>
              <th className="px-5 py-2 font-medium">Last active</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3 font-medium">{a.name} <span className="text-xs text-muted">v{a.version}</span></td>
                <td className="px-5 py-3"><Badge tone={a.status === "active" ? "success" : "muted"}>{a.status}</Badge></td>
                <td className="px-5 py-3">{a.conversationCount}</td>
                <td className="px-5 py-3">{a.messageCount}</td>
                <td className="px-5 py-3">
                  {a.toolCalls.total}
                  {a.toolCalls.total > 0 && <span className="ml-1 text-xs text-muted">({a.toolCalls.succeeded} ok, {a.toolCalls.failed} failed)</span>}
                </td>
                <td className="px-5 py-3">{fmtMs(a.avgResponseMs)}</td>
                <td className="px-5 py-3 text-muted">{fmtDate(a.lastActiveAt)}</td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-6 text-center text-muted">No agents yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
