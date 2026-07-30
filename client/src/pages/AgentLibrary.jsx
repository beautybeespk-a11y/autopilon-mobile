import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Icons from "lucide-react";
import { Card, Button, Badge } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function AgentLibrary() {
  const [templates, setTemplates] = useState([]);
  const [installing, setInstalling] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.get("/agent-library").then(setTemplates).catch(() => {}); }, []);

  const install = async (t) => {
    setInstalling(t.id);
    try {
      const agent = await api.post(`/agent-library/${t.id}/install`, {});
      navigate(`/app/agents/${agent.id}/edit`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Agent Library</h1>
        <p className="mt-1 text-muted">Starter agents you can install in one click, then customize however you like.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => {
          const Icon = Icons[t.icon] || Icons.Bot;
          return (
            <Card key={t.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={20} /></div>
                <Badge tone="muted">{t.category}</Badge>
              </div>
              <h3 className="mt-3 font-display font-semibold">{t.name}</h3>
              <p className="mt-1 text-sm text-muted">{t.description}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                {t.skillIds.slice(0, 3).map((s) => <Badge key={s} tone="accent">{s}</Badge>)}
                {t.skillIds.length > 3 && <Badge tone="muted">+{t.skillIds.length - 3} more</Badge>}
              </div>
              <Button className="mt-4 w-full" onClick={() => install(t)} disabled={installing === t.id}>
                {installing === t.id ? "Installing…" : "Install"}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
