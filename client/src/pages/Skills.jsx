import { useEffect, useState } from "react";
import * as Icons from "lucide-react";
import { Card, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";
import { BUILTIN_SKILLS } from "../lib/skills.js";

const ICON_BY_ID = Object.fromEntries(BUILTIN_SKILLS.map((s) => [s.id, s.icon]));

export default function Skills() {
  const [skills, setSkills] = useState([]);
  useEffect(() => { api.get("/skills").then(setSkills).catch(() => {}); }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Skills</h1>
        <p className="mt-1 text-muted">Capabilities you can give an agent — assign them when creating or editing an agent.</p>
      </div>
      {skills.length === 0 ? (
        <EmptyState
          icon={Icons.Wrench}
          title="No skills available"
          description="Skills couldn't be loaded — try refreshing the page."
        />
      ) : (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((s) => {
          const Icon = Icons[ICON_BY_ID[s.id]] || Icons.Wrench;
          return (
            <Card key={s.id} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={20} /></div>
                <Badge tone="success">{s.status}</Badge>
              </div>
              <h3 className="font-display font-semibold">{s.name}</h3>
              <p className="mt-1 text-sm text-muted">{s.description}</p>
              {s.category && <div className="mt-3"><Badge>{s.category}</Badge></div>}
            </Card>
          );
        })}
      </div>
      )}
    </div>
  );
}
