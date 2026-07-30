import { useEffect, useState } from "react";
import { ListChecks, Plus } from "lucide-react";
import { Card, Input, Button, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const PRIORITY_TONE = { high: "warn", medium: "accent", low: "muted" };

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");

  const load = () => api.get("/tasks").then(setTasks).catch(() => {});
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!title.trim()) return;
    await api.post("/tasks", { title });
    setTitle(""); load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Tasks</h1>
        <p className="mt-1 text-muted">Track work for you and your agents.</p>
      </div>

      <div className="flex gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a task…" className="flex-1" />
        <Button onClick={add}><Plus size={16} /> Add</Button>
      </div>

      {tasks.length === 0 ? (
        <EmptyState icon={ListChecks} title="No tasks yet" description="Add your first task above." />
      ) : (
        <Card className="divide-y divide-line">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-5 py-3">
              <span className="text-sm">{t.title}</span>
              <div className="flex items-center gap-2">
                <Badge tone={PRIORITY_TONE[t.priority] || "muted"}>{t.priority}</Badge>
                <Badge>{t.status}</Badge>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
