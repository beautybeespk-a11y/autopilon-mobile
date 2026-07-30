import { useEffect, useState } from "react";
import { Activity as ActivityIcon } from "lucide-react";
import { Card, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function Activity() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { api.get("/activity").then(setLogs).catch(() => {}); }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-muted">A log of what's happened in your workspace.</p>
      </div>
      {logs.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="No activity yet" description="Your actions will appear here as you use the platform." />
      ) : (
        <Card className="divide-y divide-line">
          {logs.map((l) => (
            <div key={l.id} className="flex items-center justify-between px-5 py-3">
              <span className="text-sm">{l.description}</span>
              <span className="font-mono text-xs text-muted">{new Date(l.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
