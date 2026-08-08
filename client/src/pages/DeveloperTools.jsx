import { useEffect, useState } from "react";
import { Webhook, Plus, Play, Trash2 } from "lucide-react";
import { Card, Button, Badge, Input, Textarea } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {
    "example": { "type": "string", "description": "An example parameter" }
  },
  "required": []
}`;

export default function DeveloperTools() {
  const [tools, setTools] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", webhookUrl: "", parametersSchema: DEFAULT_SCHEMA, requiresConfirmation: true });
  const [testResults, setTestResults] = useState({});
  const [testParams, setTestParams] = useState({});

  const load = () => api.get("/developer/tools").then(setTools).catch(() => {});
  useEffect(load, []);

  const create = async () => {
    try {
      await api.post("/developer/tools", form);
      setForm({ name: "", description: "", webhookUrl: "", parametersSchema: DEFAULT_SCHEMA, requiresConfirmation: true });
      setCreating(false);
      load();
    } catch (e) {
      alert(e.message);
    }
  };
  const publish = async (id) => { await api.post(`/developer/tools/${id}/publish`, {}); load(); };
  const disable = async (id) => { await api.post(`/developer/tools/${id}/disable`, {}); load(); };
  const remove = async (id) => { await api.del(`/developer/tools/${id}`); load(); };
  const test = async (id) => {
    let params = {};
    try { params = testParams[id] ? JSON.parse(testParams[id]) : {}; } catch { return alert("Test parameters must be valid JSON."); }
    try {
      const result = await api.post(`/developer/tools/${id}/test`, { parameters: params });
      setTestResults({ ...testResults, [id]: result });
    } catch (e) {
      setTestResults({ ...testResults, [id]: { ok: false, error: e.message } });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Developer Tools</h1>
          <p className="mt-1 text-muted">
            Build custom tools your agents can use — each one calls a webhook you host. Enable the "Custom Tools" skill on an agent to give it access to your published tools.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={16} /> New tool</Button>
      </div>

      {creating && (
        <Card className="space-y-3 p-5">
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Check Inventory Level" />
          <Input label="Description (the AI reads this to decide when to use it)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Looks up current stock for a given SKU in our warehouse system." />
          <Input label="Webhook URL" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} placeholder="https://your-server.com/webhooks/check-inventory" />
          <Textarea label="Parameters schema (JSON)" rows={6} value={form.parametersSchema} onChange={(e) => setForm({ ...form, parametersSchema: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.requiresConfirmation} onChange={(e) => setForm({ ...form, requiresConfirmation: e.target.checked })} />
            Require user approval before this tool runs
          </label>
          <div className="flex gap-2">
            <Button onClick={create}>Create</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      <div className="space-y-4">
        {tools.map((t) => (
          <Card key={t.id} className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Webhook size={20} /></div>
                <div>
                  <div className="font-mono font-semibold">{t.name}</div>
                  <p className="text-sm text-muted">{t.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={t.status === "published" ? "success" : "muted"}>{t.status}</Badge>
                <button onClick={() => remove(t.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>
              </div>
            </div>
            <p className="mt-2 truncate text-xs text-muted">{t.webhookUrl}</p>

            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1"><Input placeholder='Test parameters (JSON), e.g. {"example":"hi"}' value={testParams[t.id] || ""} onChange={(e) => setTestParams({ ...testParams, [t.id]: e.target.value })} /></div>
              <Button variant="outline" onClick={() => test(t.id)}><Play size={14} /> Test</Button>
              {t.status === "published" ? (
                <Button variant="outline" onClick={() => disable(t.id)}>Disable</Button>
              ) : (
                <Button onClick={() => publish(t.id)}>Publish</Button>
              )}
            </div>
            {testResults[t.id] && (
              <pre className={`mt-2 overflow-x-auto rounded-lg p-3 text-xs ${testResults[t.id].ok === false ? "bg-red-500/10 text-red-500" : "bg-elevated"}`}>
                {JSON.stringify(testResults[t.id], null, 2)}
              </pre>
            )}
          </Card>
        ))}
        {tools.length === 0 && !creating && (
          <p className="text-sm text-muted">No custom tools yet — create one above.</p>
        )}
      </div>
    </div>
  );
}
