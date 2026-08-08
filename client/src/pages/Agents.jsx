import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Plus, Trash2, Copy, Power, PowerOff, LibraryBig, Store } from "lucide-react";
import { Card, Button, Badge, EmptyState, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const navigate = useNavigate();

  const load = () => api.get("/agents").then(setAgents).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const remove = async (id) => { await api.del(`/agents/${id}`); load(); };
  const clone = async (id) => { setBusyId(id); try { await api.post(`/agents/${id}/clone`, {}); await load(); } finally { setBusyId(null); } };
  const toggleStatus = async (a) => {
    setBusyId(a.id);
    try { await api.post(`/agents/${a.id}/${a.status === "active" ? "deactivate" : "activate"}`, {}); await load(); }
    finally { setBusyId(null); }
  };

  const [publishingAgent, setPublishingAgent] = useState(null);
  const [publishForm, setPublishForm] = useState({ name: "", description: "" });
  const publish = async () => {
    if (!publishForm.name.trim()) return;
    const asset = await api.post(`/marketplace/assets/from-agent/${publishingAgent.id}`, publishForm);
    setPublishingAgent(null);
    setPublishForm({ name: "", description: "" });
    navigate(`/app/marketplace/${asset.id}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">My Agents</h1>
          <p className="mt-1 text-muted">Agents you've built and their skills.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" to="/app/agents/library"><LibraryBig size={16} /> Browse library</Button>
          <Button to="/app/agents/new"><Plus size={16} /> New agent</Button>
        </div>
      </div>

      {loading ? null : agents.length === 0 ? (
        <EmptyState icon={Bot} title="No agents yet" description="Create your first agent — give it a personality, instructions, and a few skills." action={<Button to="/app/agents/new"><Plus size={16} /> Create an agent</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Card key={a.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Bot size={20} /></div>
                <div className="flex gap-1">
                  <button onClick={() => navigate(`/app/agents/${a.id}/edit`)} className="rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-elevated hover:text-ink">Edit</button>
                  <button title="Clone" disabled={busyId === a.id} onClick={() => clone(a.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink disabled:opacity-50"><Copy size={16} /></button>
                  {a.isOwner && (
                    <>
                      <button title="Publish to Marketplace" onClick={() => { setPublishingAgent(a); setPublishForm({ name: a.name, description: a.description || "" }); }} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink"><Store size={16} /></button>
                      <button title={a.status === "active" ? "Deactivate" : "Activate"} disabled={busyId === a.id} onClick={() => toggleStatus(a)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink disabled:opacity-50">
                        {a.status === "active" ? <PowerOff size={16} /> : <Power size={16} />}
                      </button>
                      <button onClick={() => remove(a.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>
                    </>
                  )}
                </div>
              </div>
              <h3 className="mt-3 font-display font-semibold">{a.name}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description || "No description."}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone="accent">{a.personality}</Badge>
                <Badge tone={a.status === "active" ? "success" : "muted"}>{a.status}</Badge>
                <Badge tone="muted">v{a.version || 1}</Badge>
                {a.scope !== "personal" && <Badge tone="accent">{a.scope === "organization" ? "Shared: org" : "Shared: workspace"}</Badge>}
              </div>
              {publishingAgent?.id === a.id && (
                <div className="mt-3 space-y-2 border-t border-line pt-3">
                  <Input label="Listing name" value={publishForm.name} onChange={(e) => setPublishForm({ ...publishForm, name: e.target.value })} />
                  <Input label="Description" value={publishForm.description} onChange={(e) => setPublishForm({ ...publishForm, description: e.target.value })} />
                  <div className="flex gap-2">
                    <Button className="flex-1" onClick={publish}>Create listing</Button>
                    <Button variant="outline" onClick={() => setPublishingAgent(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
