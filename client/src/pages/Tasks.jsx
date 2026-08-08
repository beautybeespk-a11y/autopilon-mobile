import { useEffect, useState } from "react";
import { ListChecks, Plus, MessageSquare } from "lucide-react";
import { Card, Input, Button, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const PRIORITY_TONE = { high: "warn", medium: "accent", low: "muted" };

function CommentThread({ taskId }) {
  const [comments, setComments] = useState([]);
  const [text, setText] = useState("");

  const load = () => api.get(`/entities/task/${taskId}/comments`).then(setComments).catch(() => {});
  useEffect(() => { load(); }, [taskId]);

  const send = async () => {
    if (!text.trim()) return;
    await api.post(`/entities/task/${taskId}/comments`, { content: text });
    setText(""); load();
  };

  return (
    <div className="border-t border-line bg-elevated/50 px-5 py-3">
      <div className="space-y-2">
        {comments.map((c) => (
          <div key={c.id} className="text-sm">
            <span className="font-medium">{c.authorName}</span>{" "}
            <span className="text-xs text-muted">{new Date(c.createdAt).toLocaleString()}</span>
            <p className="text-muted">{c.content}</p>
          </div>
        ))}
        {comments.length === 0 && <p className="text-xs text-muted">No comments yet.</p>}
      </div>
      <div className="mt-2 flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Add a comment — use @name to mention a teammate" className="flex-1" />
        <Button onClick={send}>Send</Button>
      </div>
    </div>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [openTaskId, setOpenTaskId] = useState(null);

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
            <div key={t.id}>
              <div className="flex items-center justify-between px-5 py-3">
                <span className="text-sm">{t.title}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={PRIORITY_TONE[t.priority] || "muted"}>{t.priority}</Badge>
                  <Badge>{t.status}</Badge>
                  <button onClick={() => setOpenTaskId(openTaskId === t.id ? null : t.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink" title="Comments">
                    <MessageSquare size={16} />
                  </button>
                </div>
              </div>
              {openTaskId === t.id && <CommentThread taskId={t.id} />}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
