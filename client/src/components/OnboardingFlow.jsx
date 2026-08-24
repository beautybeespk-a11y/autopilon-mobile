import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot, Wrench, Zap, Plug, ArrowRight, X, Check,
  Megaphone, Headphones, Search, PenLine, ShoppingCart, Globe, BarChart3, Mail, Workflow, Sparkles,
} from "lucide-react";
import { Card, Button, Badge } from "./ui/index.jsx";
import { api } from "../lib/api.js";

// Human-friendly labels for the REAL agentLibrary categories (Phase 21
// Task 2 — reusing the existing starter-template category system rather
// than inventing a separate, disconnected list of "goals"). One label per
// category actually present in server/orchestrator/agentLibrary.js.
const CATEGORY_INFO = {
  marketing: { label: "Marketing", icon: Megaphone },
  support: { label: "Customer support", icon: Headphones },
  knowledge: { label: "Research", icon: Search },
  creative: { label: "Content writing", icon: PenLine },
  ecommerce: { label: "Online store", icon: ShoppingCart },
  content: { label: "Publishing", icon: Globe },
  analytics: { label: "Business analytics", icon: BarChart3 },
  productivity: { label: "Productivity", icon: Mail },
  automation: { label: "Automation", icon: Workflow },
};

export default function OnboardingFlow({ onDone }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState([]);
  const [category, setCategory] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [installedAgent, setInstalledAgent] = useState(null);

  useEffect(() => { api.get("/agent-library").then(setTemplates).catch(() => {}); }, []);

  const finish = async () => {
    try { await api.post("/onboarding/complete", {}); } catch { /* non-fatal — don't block the user leaving */ }
    onDone();
  };

  const categoriesPresent = [...new Set(templates.map((t) => t.category))].filter((c) => CATEGORY_INFO[c]);
  const matching = templates.filter((t) => t.category === category);

  const install = async (templateId) => {
    setInstalling(templateId);
    try {
      const agent = await api.post(`/agent-library/${templateId}/install`, {});
      setInstalledAgent(agent);
      setStep(3);
    } catch {
      // Installing shouldn't be able to silently fail the whole flow —
      // just let them retry or skip ahead.
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4">
      <Card className="aurora relative w-full max-w-lg overflow-hidden p-7">
        <button onClick={finish} className="absolute right-4 top-4 text-muted hover:text-ink" aria-label="Skip onboarding">
          <X size={18} />
        </button>

        {step === 0 && (
          <div>
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
              <Sparkles size={24} />
            </div>
            <h2 className="font-display text-xl font-semibold">Welcome to Autopilon</h2>
            <p className="mt-2 text-sm text-muted">
              Autopilon lets you build <strong className="text-ink">AI agents</strong> — assistants
              you set up once that can chat, use tools, and get real work done for you.
            </p>
            <div className="mt-5 space-y-3 text-sm">
              <div className="flex gap-3">
                <Bot size={18} className="mt-0.5 shrink-0 text-accent" />
                <p><strong className="text-ink">An agent</strong> is an AI assistant with instructions and a job — e.g. "Customer Support" or "Content Writer."</p>
              </div>
              <div className="flex gap-3">
                <Wrench size={18} className="mt-0.5 shrink-0 text-accent" />
                <p><strong className="text-ink">Skills</strong> are specific abilities you give an agent, like searching the web or reading files.</p>
              </div>
              <div className="flex gap-3">
                <Plug size={18} className="mt-0.5 shrink-0 text-accent" />
                <p><strong className="text-ink">Integrations</strong> connect an agent to real tools you use — like Gmail, WhatsApp, or your online store.</p>
              </div>
              <div className="flex gap-3">
                <Zap size={18} className="mt-0.5 shrink-0 text-accent" />
                <p><strong className="text-ink">Automations</strong> let an agent run on its own when something happens, without you asking each time.</p>
              </div>
            </div>
            <Button className="mt-6 w-full" onClick={() => setStep(1)}>Let's go <ArrowRight size={16} /></Button>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="font-display text-xl font-semibold">What do you want help with?</h2>
            <p className="mt-1 text-sm text-muted">Pick the closest match — you can always create more agents later.</p>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              {categoriesPresent.map((c) => {
                const { label, icon: Icon } = CATEGORY_INFO[c];
                return (
                  <button
                    key={c}
                    onClick={() => { setCategory(c); setStep(2); }}
                    className="flex flex-col items-start gap-2 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent/50 hover:bg-elevated"
                  >
                    <Icon size={20} className="text-accent" />
                    <span className="text-sm font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 block w-full text-center text-xs text-muted hover:text-ink">
              I'll explore on my own
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="font-display text-xl font-semibold">{CATEGORY_INFO[category]?.label} agents</h2>
            <p className="mt-1 text-sm text-muted">Install one to get started — this creates a real, ready-to-use agent.</p>
            <div className="mt-5 space-y-2.5">
              {matching.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="mt-0.5 text-xs text-muted">{t.description}</div>
                  </div>
                  <Button
                    variant="outline"
                    className="shrink-0 px-3 py-2 text-xs"
                    disabled={installing === t.id}
                    onClick={() => install(t.id)}
                  >
                    {installing === t.id ? "Installing…" : "Install"}
                  </Button>
                </div>
              ))}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 block w-full text-center text-xs text-muted hover:text-ink">
              Skip for now
            </button>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent2/15 text-accent2">
              <Check size={24} />
            </div>
            <h2 className="font-display text-xl font-semibold">
              {installedAgent ? `${installedAgent.name} is ready` : "You're all set"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {installedAgent
                ? "Head to Chat to start talking to your new agent — or connect an integration first if it needs one."
                : "You can create an agent, connect an integration, or start chatting anytime from the dashboard."}
            </p>
            {installedAgent && (
              <div className="mt-3"><Badge tone="accent">Ready to use</Badge></div>
            )}
            <div className="mt-6 flex gap-2.5">
              <Button className="flex-1" onClick={async () => { await finish(); navigate("/app/chat"); }}>
                Start chatting <ArrowRight size={16} />
              </Button>
              <Button variant="outline" onClick={finish}>Go to dashboard</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
