import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Zap, Plus, Play, Pause, Trash2, Clock, CheckCircle2, XCircle,
  TrendingUp, Timer, ChevronDown, ChevronUp, Sparkles, Radio, Layers, ShieldAlert,
} from "lucide-react";
import { Card, Button, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

function StatCard({ icon: Icon, label, value }) {
  return (
    <Card className="p-4">
      <div className="mb-2 grid h-8 w-8 place-items-center rounded-lg bg-elevated text-muted"><Icon size={16} /></div>
      <div className="font-display text-xl font-semibold">{value ?? "—"}</div>
      <div className="text-xs text-muted">{label}</div>
    </Card>
  );
}

const STATUS_TONE = { active: "success", paused: "warn", draft: "muted" };

function RunsList({ automationId }) {
  const [runs, setRuns] = useState(null);
  useEffect(() => { api.get(`/automations/${automationId}/runs`).then(setRuns).catch(() => setRuns([])); }, [automationId]);
  if (runs === null) return <p className="px-4 py-3 text-xs text-muted">Loading runs…</p>;
  if (runs.length === 0) return <p className="px-4 py-3 text-xs text-muted">No runs yet.</p>;
  return (
    <div className="divide-y divide-line border-t border-line">
      {runs.map((r) => (
        <div key={r.id} className="flex items-center justify-between px-4 py-2 text-xs">
          <span className="flex items-center gap-1.5">
            {r.status === "completed" ? <CheckCircle2 size={13} className="text-accent2" /> : r.status === "failed" ? <XCircle size={13} className="text-red-500" /> : <Clock size={13} className="text-muted" />}
            {r.triggerSource} · {r.status}
          </span>
          <span className="font-mono text-muted">{new Date(r.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function PendingApprovals() {
  const [pending, setPending] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => api.get("/confirmations/pending").then(setPending).catch(() => setPending([]));
  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const [error, setError] = useState("");

  const resolve = async (id, approved) => {
    setBusyId(id);
    setError("");
    try {
      await api.post(`/confirmations/${id}/${approved ? "approve" : "reject"}`, {});
      load();
    } catch (err) {
      setError(err.message); // e.g. "This confirmation has expired." — was previously silently swallowed
      load(); // refresh anyway — the item may now be gone from the pending list
    } finally {
      setBusyId(null);
    }
  };

  if ((!pending || pending.length === 0) && !error) return null; // nothing waiting and nothing to report — don't clutter the page

  return (
    <Card className="border-amber-500/30 bg-amber-500/5 p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert size={16} className="text-amber-500" />
        <h2 className="font-display font-semibold">Waiting for your approval</h2>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
      <div className="space-y-2">
        {(pending || []).map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3">
            <div className="min-w-0">
              {c.automationName && <Badge tone="accent">{c.automationName}</Badge>}
              <p className="mt-1 text-sm">{c.reason}</p>
            </div>
            <div className="flex gap-2">
              <Button className="px-3 py-1.5 text-xs" onClick={() => resolve(c.id, true)} disabled={busyId === c.id}>Approve</Button>
              <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={() => resolve(c.id, false)} disabled={busyId === c.id}>Reject</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EventsPanel() {
  const [events, setEvents] = useState(null);
  const [queue, setQueue] = useState(null);

  useEffect(() => {
    api.get("/automations/events").then(setEvents).catch(() => setEvents([]));
    api.get("/automations/queue-health").then(setQueue).catch(() => {});
    const interval = setInterval(() => {
      api.get("/automations/queue-health").then(setQueue).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radio size={16} className="text-accent" />
        <h2 className="font-display font-semibold">Events &amp; queue</h2>
      </div>

      {queue && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Queued", queue.queued, "muted"],
            ["Processing", queue.processing, "accent"],
            ["Completed", queue.completed, "success"],
            ["Failed (retrying)", queue.failed, "warn"],
            ["Dead-lettered", queue.deadLetter, "muted"],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-lg border border-line bg-elevated px-2.5 py-2">
              <div className="font-display text-lg font-semibold">{value}</div>
              <div className="text-[11px] text-muted">{label}</div>
            </div>
          ))}
        </div>
      )}

      {events === null ? null : events.length === 0 ? (
        <p className="text-sm text-muted">No events yet — these appear as WhatsApp messages, Meta Ads changes, tasks, and webhooks come in.</p>
      ) : (
        <div className="divide-y divide-line">
          {events.slice(0, 8).map((e) => (
            <div key={e.id} className="flex items-center justify-between py-2 text-xs">
              <span className="flex items-center gap-2">
                <Layers size={12} className="text-muted" />
                <Badge>{e.source}</Badge>
                <span>{e.eventType}</span>
                {e.matchedAutomations.length > 0 && <Badge tone="accent">{e.matchedAutomations.length} matched</Badge>}
              </span>
              <span className="font-mono text-muted">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Automations() {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState(null);
  const [automations, setAutomations] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    api.get("/automations/dashboard").then(setMetrics).catch(() => {});
    api.get("/automations").then(setAutomations).catch(() => {});
  };
  useEffect(load, []);

  const openTemplates = () => {
    api.get("/automations/templates").then(setTemplates).catch(() => {});
    setShowTemplates(true);
  };

  const useTemplate = async (templateId) => {
    setBusyId(templateId);
    try {
      await api.post(`/automations/from-template/${templateId}`, {});
      setShowTemplates(false);
      load();
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = async (a) => {
    setBusyId(a.id);
    try {
      await api.post(`/automations/${a.id}/${a.status === "active" ? "pause" : "activate"}`, {});
      load();
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (a) => {
    setBusyId(a.id);
    try {
      await api.post(`/automations/${a.id}/run`, {});
      load();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a) => {
    if (!confirm(`Delete "${a.name}"? This cannot be undone.`)) return;
    await api.del(`/automations/${a.id}`);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Automations</h1>
          <p className="mt-1 text-muted">Workflows that run your agents' tools on a schedule or trigger.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openTemplates}><Sparkles size={16} /> Templates</Button>
          <Button onClick={() => navigate("/app/automations/new")}><Plus size={16} /> New workflow</Button>
        </div>
      </div>

      <PendingApprovals />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Zap} label="Active workflows" value={metrics?.activeWorkflows} />
        <StatCard icon={Pause} label="Paused workflows" value={metrics?.pausedWorkflows} />
        <StatCard icon={Clock} label="Today's executions" value={metrics?.todaysExecutions} />
        <StatCard icon={XCircle} label="Failed today" value={metrics?.failedExecutions} />
        <StatCard icon={TrendingUp} label="Success rate" value={metrics?.successRate != null ? `${metrics.successRate}%` : "—"} />
        <StatCard icon={Timer} label="Avg runtime" value={metrics?.avgRuntimeMs != null ? `${(metrics.avgRuntimeMs / 1000).toFixed(1)}s` : "—"} />
        <StatCard icon={Play} label="Running now" value={metrics?.runningWorkflows} />
      </div>

      <EventsPanel />

      {automations.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No workflows yet"
          description={'Start from a template, build one step by step, or ask an agent in chat to build one — e.g. "Every day at 9 AM research Korean skincare trends and save a report."'}
          action={<Button onClick={openTemplates}><Sparkles size={16} /> Browse templates</Button>}
        />
      ) : (
        <div className="space-y-3">
          {automations.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    <Badge tone={STATUS_TONE[a.status] || "muted"}>{a.status}</Badge>
                    <Badge>{a.triggerType}</Badge>
                    {a.orgId && <Badge tone="accent">{a.workspaceId ? "Shared: workspace" : "Shared: org"}</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{a.description}</p>
                  <div className="mt-1 flex gap-3 font-mono text-xs text-muted">
                    {a.lastRunAt && <span>Last run: {new Date(a.lastRunAt).toLocaleString()}</span>}
                    {a.nextRunAt && <span>Next: {new Date(a.nextRunAt).toLocaleString()}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="outline" className="px-2.5 py-1.5 text-xs" onClick={() => runNow(a)} disabled={busyId === a.id}>
                    <Play size={13} /> Run now
                  </Button>
                  <Button variant="outline" className="px-2.5 py-1.5 text-xs" onClick={() => toggleStatus(a)} disabled={busyId === a.id}>
                    {a.status === "active" ? <><Pause size={13} /> Pause</> : <><Play size={13} /> Activate</>}
                  </Button>
                  <Button variant="outline" className="px-2.5 py-1.5 text-xs" onClick={() => navigate(`/app/automations/${a.id}/edit`)}>Edit</Button>
                  <button
                    onClick={() => setExpandedRuns(expandedRuns === a.id ? null : a.id)}
                    className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    Runs {expandedRuns === a.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button onClick={() => remove(a)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={14} /></button>
                </div>
              </div>
              {expandedRuns === a.id && <RunsList automationId={a.id} />}
            </Card>
          ))}
        </div>
      )}

      {showTemplates && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setShowTemplates(false)}>
          <Card className="max-h-[80vh] w-full max-w-2xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-lg font-semibold">Workflow templates</h2>
            <p className="mt-1 text-sm text-muted">Clones as a draft — review and customize before activating.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => useTemplate(t.id)}
                  disabled={busyId === t.id}
                  className="rounded-xl border border-line p-4 text-left hover:border-accent/40 disabled:opacity-50"
                >
                  <div className="font-medium">{t.name}</div>
                  <p className="mt-1 text-xs text-muted">{t.description}</p>
                  <Badge className="mt-2">{t.triggerType}</Badge>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
