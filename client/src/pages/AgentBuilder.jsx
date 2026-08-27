import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as Icons from "lucide-react";
import { Card, Input, Textarea, Button } from "../components/ui/index.jsx";
import { BUILTIN_SKILLS } from "../lib/skills.js";
import { api } from "../lib/api.js";

const PERSONALITIES = ["Professional", "Friendly", "Creative", "Direct", "Custom"];

export default function AgentBuilder() {
  const navigate = useNavigate();
  const { id } = useParams(); // present when editing an existing agent
  const [form, setForm] = useState({ name: "", description: "", personality: "Professional", instructions: "", aiProvider: "", aiModel: "", orgId: "", workspaceId: "" });
  const [skillIds, setSkillIds] = useState([]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [manageableOrgs, setManageableOrgs] = useState([]);
  const [orgWorkspaces, setOrgWorkspaces] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [error, setError] = useState("");
  const [templateSync, setTemplateSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const loadTemplateSync = () => {
    if (!id) return;
    api.get(`/agent-library/agents/${id}/template-sync`).then(setTemplateSync).catch(() => setTemplateSync(null));
  };
  useEffect(loadTemplateSync, [id]);

  // force=true only after the user has confirmed they want to overwrite
  // their own hand edits — the first attempt always goes through without
  // it, so a real edit never gets silently discarded.
  const updateFromTemplate = async (force = false) => {
    setSyncing(true);
    try {
      const agent = await api.post(`/agent-library/agents/${id}/template-sync`, { force });
      setForm((f) => ({ ...f, instructions: agent.instructions }));
      setSkillIds((agent.skills || []).map((s) => s.id));
      loadTemplateSync();
    } catch (err) {
      if (err.data?.code === "CUSTOMIZED") {
        if (window.confirm(`${err.message}\n\nOverwrite your changes with the latest template instructions?`)) {
          await updateFromTemplate(true);
          return;
        }
      } else {
        setError(err.message);
      }
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => { api.get("/chat/provider-options").then(setProviderOptions).catch(() => {}); }, []);
  useEffect(() => {
    api.get("/organizations").then((orgs) => setManageableOrgs(orgs.filter((o) => ["owner", "admin"].includes(o.myRole)))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!form.orgId) { setOrgWorkspaces([]); return; }
    api.get(`/organizations/${form.orgId}/workspaces`).then(setOrgWorkspaces).catch(() => setOrgWorkspaces([]));
  }, [form.orgId]);

  useEffect(() => {
    if (!id) return;
    api.get(`/agents/${id}`).then((a) => {
      setForm({
        name: a.name,
        description: a.description || "",
        personality: (a.personality || "professional").replace(/^\w/, (c) => c.toUpperCase()),
        instructions: a.instructions || "",
        aiProvider: a.aiProvider || "",
        aiModel: a.aiModel || "",
        orgId: a.orgId || "",
        workspaceId: a.workspaceId || "",
      });
      setSkillIds((a.skills || []).map((s) => s.id));
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [id]);

  const toggleSkill = (skillId) => setSkillIds((s) => (s.includes(skillId) ? s.filter((x) => x !== skillId) : [...s, skillId]));

  const save = async () => {
    setError(""); setBusy(true);
    try {
      const payload = { ...form, personality: form.personality.toLowerCase(), skillIds };
      if (id) await api.patch(`/agents/${id}`, payload);
      else await api.post("/agents", payload);
      navigate("/app/agents");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (!loaded) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">{id ? "Edit agent" : "Agent Builder"}</h1>
        <p className="mt-1 text-muted">{id ? "Update this agent's behavior and enabled skills." : "Define how your agent behaves and what it can do."}</p>
      </div>

      {templateSync?.fromTemplate && templateSync.updateAvailable && (
        <Card className="flex items-center justify-between gap-4 border-accent/40 bg-accent/5 p-4">
          <div>
            <div className="text-sm font-medium">An update is available for this agent</div>
            <p className="mt-0.5 text-xs text-muted">
              {templateSync.templateRemoved
                ? "The template this was installed from no longer exists."
                : `"${templateSync.templateName}" has been improved since this agent was installed or last updated.${templateSync.customized ? " Note: you've edited this agent's instructions since then." : ""}`}
            </p>
          </div>
          {!templateSync.templateRemoved && (
            <Button variant="outline" onClick={() => updateFromTemplate(false)} disabled={syncing}>
              {syncing ? "Updating…" : "Update to latest"}
            </Button>
          )}
        </Card>
      )}

      <Card className="space-y-5 p-6">
        <Input label="Agent name" value={form.name} onChange={set("name")} placeholder="e.g. Marketing Assistant" />
        <Input label="Description" value={form.description} onChange={set("description")} placeholder="What is this agent for?" />

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Personality</span>
          <div className="flex flex-wrap gap-2">
            {PERSONALITIES.map((p) => (
              <button
                key={p}
                onClick={() => setForm({ ...form, personality: p })}
                className={`rounded-xl border px-3.5 py-2 text-sm ${form.personality === p ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink"}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <Textarea label="Instructions" rows={5} value={form.instructions} onChange={set("instructions")} placeholder="Tell your AI agent how it should behave." />
      </Card>

      <Card className="p-6">
        <h2 className="font-display font-semibold">Skills</h2>
        <p className="mt-1 text-sm text-muted">Select the capabilities this agent can use.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {BUILTIN_SKILLS.map((s) => {
            const Icon = Icons[s.icon] || Icons.Wrench;
            const on = skillIds.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleSkill(s.id)}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${on ? "border-accent bg-accent/5" : "border-line hover:border-accent/40"}`}
              >
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${on ? "accent-gradient text-white" : "bg-elevated text-muted"}`}><Icon size={18} /></div>
                <div>
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted">{s.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="space-y-4 p-6">
        <div>
          <h2 className="font-display font-semibold">AI Model</h2>
          <p className="mt-1 text-sm text-muted">Choose which AI this agent uses, or leave on the platform default.</p>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Provider</span>
          <select
            value={form.aiProvider}
            onChange={(e) => setForm({ ...form, aiProvider: e.target.value, aiModel: "" })}
            className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm"
          >
            <option value="">Platform default</option>
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.label}{!p.configured ? " (not configured)" : ""}
              </option>
            ))}
          </select>
        </div>
        {form.aiProvider && (
          <Input
            label="Model (optional)"
            value={form.aiModel}
            onChange={set("aiModel")}
            placeholder="Leave blank to use this provider's default model"
          />
        )}
      </Card>

      {manageableOrgs.length > 0 && (
        <Card className="space-y-4 p-6">
          <div>
            <h2 className="font-display font-semibold">Sharing</h2>
            <p className="mt-1 text-sm text-muted">Keep this agent personal, or share it with an organization (and optionally one workspace within it).</p>
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-muted">Organization</span>
            <select
              value={form.orgId}
              onChange={(e) => setForm({ ...form, orgId: e.target.value, workspaceId: "" })}
              className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm"
            >
              <option value="">Personal (only you)</option>
              {manageableOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          {form.orgId && (
            <div>
              <span className="mb-1.5 block text-sm font-medium text-muted">Workspace (optional)</span>
              <select
                value={form.workspaceId}
                onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}
                className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm"
              >
                <option value="">Whole organization</option>
                {orgWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
        </Card>
      )}

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/app/agents")}>Cancel</Button>
        <Button onClick={save} disabled={busy || !form.name.trim()}>
          {busy ? (id ? "Saving…" : "Creating…") : id ? "Save changes" : "Create agent"}
        </Button>
      </div>
    </div>
  );
}
