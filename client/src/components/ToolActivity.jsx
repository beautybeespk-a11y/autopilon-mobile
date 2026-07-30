import { Loader2, Check, Clock, Search, Wrench, Brain, AlertTriangle, Plug } from "lucide-react";

const STEP_META = {
  planning:   { label: "Planning",           icon: Brain },
  researching:{ label: "Researching",         icon: Search },
  integration:{ label: "Integration selected", icon: Plug },
  tool:       { label: "Using tool",          icon: Wrench },
  waiting:    { label: "Waiting for approval", icon: Clock },
  completed:  { label: "Completed",           icon: Check },
  error:      { label: "Failed",              icon: AlertTriangle },
};

// A reusable trace of an agent's steps. Real tools aren't connected in Phase 1;
// this renders whatever steps are passed to it so tool runs can appear inline later.
export default function ToolActivity({ steps = [] }) {
  return (
    <div className="rounded-xl border border-line bg-elevated/60 p-3 font-mono text-xs">
      <div className="mb-2 flex items-center gap-2 text-muted">
        <span className="inline-block h-2 w-2 rounded-full accent-gradient" /> Agent trace
      </div>
      <ol className="relative ml-1 space-y-2 border-l border-line pl-4">
        {steps.map((s, i) => {
          const meta = STEP_META[s.type] || STEP_META.tool;
          const Icon = meta.icon;
          const active = s.state === "active";
          const done = s.state === "done";
          const isError = s.type === "error";
          return (
            <li key={i} className="relative">
              <span
                className={`absolute -left-[21px] grid h-4 w-4 place-items-center rounded-full ${
                  isError ? "bg-red-500 text-white" : done ? "bg-accent2 text-white" : active ? "bg-accent text-white" : "bg-line text-muted"
                }`}
              >
                {active ? <Loader2 size={10} className="animate-spin" /> : <Icon size={10} />}
              </span>
              <span className={isError ? "text-red-500" : done || active ? "text-ink" : "text-muted"}>
                {meta.label}{s.detail ? ` — ${s.detail}` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
