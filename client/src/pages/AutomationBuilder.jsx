import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { Card, Input, Textarea, Button } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TRIGGER_TYPES = [
  { id: "manual", label: "Manual — run it yourself" },
  { id: "schedule", label: "Schedule — runs automatically" },
  { id: "whatsapp_message", label: "WhatsApp message received" },
  { id: "meta_ads_event", label: "Meta Ads change (campaign created/updated/paused/resumed)" },
  { id: "webhook", label: "External webhook" },
  { id: "task_created", label: "Task created" },
  { id: "task_completed", label: "Task completed" },
  { id: "automation_completed", label: "Another workflow completed" },
  { id: "automation_failed", label: "Another workflow failed" },
  { id: "ai_chat_request", label: "AI chat request (not yet auto-firing)" },
  { id: "knowledge_update", label: "Knowledge update (not yet auto-firing)" },
  { id: "task_due", label: "Task due (not yet auto-firing)" },
];

const FREQUENCIES = ["every_minute", "hourly", "daily", "weekly", "monthly", "cron"];

const STEP_TYPES = ["action", "condition", "ai_decision", "approval", "delay", "loop", "end"];

function ParametersField({ parameters, onChange }) {
  const [text, setText] = useState(JSON.stringify(parameters || {}, null, 2));
  const [invalid, setInvalid] = useState(false);

  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-muted">Parameters (JSON, supports {"{{variableName}}"})</span>
      <textarea
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value); // always let the user keep typing, valid or not
          try {
            onChange(JSON.parse(value));
            setInvalid(false);
          } catch {
            setInvalid(true); // don't commit upstream until it's valid JSON again
          }
        }}
        rows={4}
        className={`w-full rounded-xl border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent ${invalid ? "border-amber-500/50" : "border-line"}`}
      />
      {invalid && <span className="mt-1 block text-xs text-amber-500">Not valid JSON yet — keep typing.</span>}
    </label>
  );
}

function StepEditor({ step, onChange, onRemove, onMove, isFirst, isLast }) {
  const config = step.config || {};
  const setConfig = (patch) => onChange({ ...step, config: { ...config, ...patch } });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <select
          value={step.type}
          onChange={(e) => onChange({ ...step, type: e.target.value, config: {} })}
          className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm font-medium outline-none focus:border-accent"
        >
          {STEP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex gap-1">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="rounded-lg p-1.5 text-muted hover:bg-elevated disabled:opacity-30"><ChevronUp size={15} /></button>
          <button onClick={() => onMove(1)} disabled={isLast} className="rounded-lg p-1.5 text-muted hover:bg-elevated disabled:opacity-30"><ChevronDown size={15} /></button>
          <button onClick={onRemove} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={15} /></button>
        </div>
      </div>

      <div className="mt-3 space-y-2.5">
        {step.type === "action" && (
          <>
            <Input label="Tool name" value={config.toolName || ""} onChange={(e) => setConfig({ toolName: e.target.value })} placeholder="e.g. create_task, list_campaigns, web_search" />
            <ParametersField parameters={config.parameters} onChange={(parameters) => setConfig({ parameters })} />
            <Input label="Save result as variable" value={config.resultVariable || ""} onChange={(e) => setConfig({ resultVariable: e.target.value })} placeholder="e.g. campaigns" />
          </>
        )}

        {step.type === "condition" && (
          <>
            <p className="text-xs text-muted">If false, jump to step number (0-indexed) — leave blank to just continue.</p>
            <Input label="Field (e.g. {{campaigns.length}})" value={config.field || ""} onChange={(e) => setConfig({ groups: [[{ field: e.target.value, op: config.op || "equals", value: config.value || "" }]] })} />
            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-muted">Operator</span>
                <select
                  value={config.op || "equals"}
                  onChange={(e) => setConfig({ op: e.target.value, groups: [[{ field: config.field, op: e.target.value, value: config.value }]] })}
                  className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent"
                >
                  {["equals", "not_equals", "contains", "greater_than", "less_than", "exists", "empty"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
              <Input label="Value" value={config.value || ""} onChange={(e) => setConfig({ value: e.target.value, groups: [[{ field: config.field, op: config.op, value: e.target.value }]] })} />
            </div>
            <Input label="If false, jump to step #" type="number" value={config.onFalse ?? ""} onChange={(e) => setConfig({ onFalse: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </>
        )}

        {step.type === "ai_decision" && (
          <>
            <Textarea label="Question for the AI" rows={2} value={config.question || ""} onChange={(e) => setConfig({ question: e.target.value })} />
            <Input label="Options (comma-separated, optional)" value={(config.options || []).join(", ")} onChange={(e) => setConfig({ options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            <Input label="Save result as variable" value={config.resultVariable || ""} onChange={(e) => setConfig({ resultVariable: e.target.value })} placeholder="e.g. aiDecision" />
          </>
        )}

        {step.type === "approval" && (
          <Textarea label="What should the approval message say?" rows={2} value={config.reason || ""} onChange={(e) => setConfig({ reason: e.target.value })} />
        )}

        {step.type === "delay" && (
          <Input label="Seconds to wait (max 60 in this version)" type="number" value={config.seconds || ""} onChange={(e) => setConfig({ seconds: Number(e.target.value) })} />
        )}

        {step.type === "loop" && (
          <>
            <Input label="Variable to loop over (e.g. {{campaigns}})" value={config.overVariable || ""} onChange={(e) => setConfig({ overVariable: e.target.value })} />
            <Input label="Name for each item" value={config.itemVariable || "item"} onChange={(e) => setConfig({ itemVariable: e.target.value })} />
            <p className="text-xs text-muted">Nested steps aren't editable here yet — set them via the JSON parameters of an action step, or edit the automation's steps directly through the API for complex loops.</p>
          </>
        )}

        {step.type === "end" && <p className="text-xs text-muted">Ends the workflow here.</p>}
      </div>
    </Card>
  );
}

export default function AutomationBuilder() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [form, setForm] = useState({ name: "", description: "", triggerType: "manual", triggerConfig: {}, agentId: "" });
  const [agents, setAgents] = useState([]);
  const [steps, setSteps] = useState([]);
  const [loaded, setLoaded] = useState(!id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/agents").then((list) => {
      setAgents(list);
      // Default to the user's first agent so a new workflow has skills/tools
      // available out of the box — same fallback used in the Chat page.
      setForm((f) => (f.agentId || id ? f : { ...f, agentId: list[0]?.id || "" }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    api.get(`/automations/${id}`).then((a) => {
      setForm({ name: a.name, description: a.description || "", triggerType: a.triggerType, triggerConfig: JSON.parse(a.triggerConfig || "{}"), agentId: a.agentId || "" });
      setSteps(a.steps.map((s) => ({ type: s.type, config: s.config })));
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [id]);

  const addStep = () => setSteps((s) => [...s, { type: "action", config: {} }]);
  const updateStep = (i, next) => setSteps((s) => s.map((st, idx) => (idx === i ? next : st)));
  const removeStep = (i) => setSteps((s) => s.filter((_, idx) => idx !== i));
  const moveStep = (i, dir) => setSteps((s) => {
    const next = [...s];
    const target = i + dir;
    if (target < 0 || target >= next.length) return s;
    [next[i], next[target]] = [next[target], next[i]];
    return next;
  });

  const save = async () => {
    setError(""); setBusy(true);
    try {
      const payload = { ...form, steps };
      if (id) await api.patch(`/automations/${id}`, payload);
      else await api.post("/automations", payload);
      navigate("/app/automations");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">{id ? "Edit workflow" : "New workflow"}</h1>
        <p className="mt-1 text-muted">Saved as a draft — activate it from the Automations list when you're ready.</p>
      </div>

      <Card className="space-y-4 p-6">
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Morning Business Report" />
        <Textarea label="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Agent</span>
          <select
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent"
          >
            <option value="">No agent (steps needing tools will fail)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">Determines which skills/tools this workflow's action steps are allowed to use.</p>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Trigger</span>
          <select
            value={form.triggerType}
            onChange={(e) => setForm({ ...form, triggerType: e.target.value })}
            className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent"
          >
            {TRIGGER_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>

        {form.triggerType === "schedule" && (
          <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-line bg-elevated p-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Frequency</span>
              <select
                value={form.triggerConfig.frequency || "daily"}
                onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, frequency: e.target.value } })}
                className="w-full rounded-lg border border-line bg-bg px-2.5 py-2 text-sm outline-none focus:border-accent"
              >
                {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            {form.triggerConfig.frequency === "cron" ? (
              <Input label="Cron expression" value={form.triggerConfig.cron || ""} onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, cron: e.target.value } })} placeholder="0 9 * * *" />
            ) : (
              <Input label="Hour (24h)" type="number" value={form.triggerConfig.hour ?? 9} onChange={(e) => setForm({ ...form, triggerConfig: { ...form.triggerConfig, hour: Number(e.target.value) } })} />
            )}
          </div>
        )}

        {form.triggerType === "whatsapp_message" && (
          <div className="rounded-xl border border-line bg-elevated p-3">
            <Input
              label="Only run if the message contains (optional)"
              value={form.triggerConfig.keyword || ""}
              onChange={(e) => {
                const keyword = e.target.value;
                setForm({
                  ...form,
                  triggerConfig: {
                    ...form.triggerConfig,
                    keyword,
                    filter: keyword ? [[{ field: "{{messageText}}", op: "contains", value: keyword }]] : undefined,
                  },
                });
              }}
              placeholder="e.g. price"
            />
          </div>
        )}

        {form.triggerType === "meta_ads_event" && (
          <div className="rounded-xl border border-line bg-elevated p-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-muted">Only run for this change (optional)</span>
              <select
                value={form.triggerConfig.eventSubtype || ""}
                onChange={(e) => {
                  const eventSubtype = e.target.value;
                  setForm({
                    ...form,
                    triggerConfig: {
                      ...form.triggerConfig,
                      eventSubtype,
                      filter: eventSubtype ? [[{ field: "{{eventSubtype}}", op: "equals", value: eventSubtype }]] : undefined,
                    },
                  });
                }}
                className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent"
              >
                <option value="">Any change</option>
                <option value="campaign_created">Campaign created</option>
                <option value="campaign_updated">Campaign updated</option>
                <option value="campaign_paused">Campaign paused</option>
                <option value="campaign_resumed">Campaign resumed</option>
              </select>
            </label>
          </div>
        )}

        {form.triggerType === "webhook" && (
          <div className="rounded-xl border border-line bg-elevated p-3 text-sm">
            {id && form.triggerConfig.secret ? (
              <>
                <p className="mb-2 text-muted">Send a POST request here to trigger this workflow:</p>
                <code className="block break-all rounded-lg bg-bg px-2.5 py-2 text-xs">
                  {window.location.origin}/api/triggers/webhook/{id}
                </code>
                <p className="mt-2 mb-1 text-muted">With this header (keep it secret):</p>
                <code className="block break-all rounded-lg bg-bg px-2.5 py-2 text-xs">x-webhook-secret: {form.triggerConfig.secret}</code>
              </>
            ) : (
              <p className="text-muted">Save this workflow once to generate its webhook URL and secret.</p>
            )}
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Steps</h2>
        <Button variant="outline" onClick={addStep}><Plus size={16} /> Add step</Button>
      </div>

      {steps.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">No steps yet — add one above.</Card>
      ) : (
        <div className="space-y-3">
          {steps.map((step, i) => (
            <StepEditor key={i} step={step} onChange={(next) => updateStep(i, next)} onRemove={() => removeStep(i)} onMove={(dir) => moveStep(i, dir)} isFirst={i === 0} isLast={i === steps.length - 1} />
          ))}
        </div>
      )}

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/app/automations")}>Cancel</Button>
        <Button onClick={save} disabled={busy || !form.name.trim()}>{busy ? "Saving…" : "Save draft"}</Button>
      </div>
    </div>
  );
}
