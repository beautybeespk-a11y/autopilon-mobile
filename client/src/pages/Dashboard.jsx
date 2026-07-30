import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot, Wrench, Puzzle, Zap, MessageSquare, BookOpen, Plug, Plus, ArrowRight, Activity as ActivityIcon,
} from "lucide-react";
import { Card, Button } from "../components/ui/index.jsx";
import { useAuth } from "../lib/auth.jsx";
import { api } from "../lib/api.js";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const QUICK = [
  { icon: MessageSquare, label: "Start a conversation", to: "/app/chat" },
  { icon: Bot, label: "Create an AI agent", to: "/app/agents/new" },
  { icon: BookOpen, label: "Add knowledge", to: "/app/knowledge" },
  { icon: Plug, label: "Connect an integration", to: "/app/integrations" },
];

const SUGGESTIONS = ["Create a marketing plan", "Analyze a document", "Build an AI agent", "Research a business idea"];

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [prompt, setPrompt] = useState("");

  useEffect(() => { api.get("/dashboard").then(setStats).catch(() => {}); }, []);

  const submitPrompt = (text) => {
    const q = (text ?? prompt).trim();
    if (!q) return;
    navigate("/app/chat", { state: { prompt: q } });
  };

  const overview = [
    { icon: Bot, label: "Active agents", value: stats?.activeAgents ?? "—" },
    { icon: Wrench, label: "Available skills", value: stats?.availableSkills ?? "—" },
    { icon: Puzzle, label: "Connected integrations", value: stats?.connectedIntegrations ?? "—" },
    { icon: Zap, label: "Running automations", value: stats?.runningAutomations ?? "—" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-semibold md:text-3xl">{greeting()}, {user?.name?.split(" ")[0]}</h1>
        <p className="mt-1 text-muted">Your AI workspace is ready.</p>
      </div>

      {/* AI quick prompt */}
      <Card className="aurora overflow-hidden p-6">
        <label className="mb-2 block font-display text-lg font-semibold">What would you like your AI assistant to do?</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitPrompt()}
            placeholder="Describe a task…"
            className="flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          <Button onClick={() => submitPrompt()} className="px-5 py-3">Send <ArrowRight size={16} /></Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => submitPrompt(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted hover:text-ink">
              {s}
            </button>
          ))}
        </div>
      </Card>

      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK.map(({ icon: Icon, label, to }) => (
          <Card as="button" key={label} onClick={() => navigate(to)} className="group flex items-center gap-3 p-4 text-left hover:border-accent/40">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={20} /></div>
            <span className="text-sm font-medium">{label}</span>
            <Plus size={16} className="ml-auto text-muted transition group-hover:text-accent" />
          </Card>
        ))}
      </div>

      {/* Overview cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {overview.map(({ icon: Icon, label, value }) => (
          <Card key={label} className="p-5">
            <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-elevated text-muted"><Icon size={18} /></div>
            <div className="font-display text-2xl font-semibold">{value}</div>
            <div className="text-sm text-muted">{label}</div>
          </Card>
        ))}
      </div>

      {/* Recent activity */}
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <ActivityIcon size={18} className="text-accent" />
          <h2 className="font-display text-lg font-semibold">Recent activity</h2>
        </div>
        {stats?.recentActivity?.length ? (
          <ul className="divide-y divide-line">
            {stats.recentActivity.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3 text-sm">
                <span>{a.description}</span>
                <span className="font-mono text-xs text-muted">{new Date(a.createdAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-muted">Nothing here yet. Start a conversation or create an agent to see activity.</p>
        )}
      </Card>
    </div>
  );
}
