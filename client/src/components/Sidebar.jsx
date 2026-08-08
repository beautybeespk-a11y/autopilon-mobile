import { NavLink } from "react-router-dom";
import { Sparkles, Shield } from "lucide-react";
import { NAV } from "./nav-items.js";
import { useAuth } from "../lib/auth.jsx";

export default function Sidebar() {
  const { user } = useAuth();
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-xl accent-gradient text-white shadow-glow">
          <Sparkles size={18} />
        </div>
        <span className="font-display text-[15px] font-semibold tracking-tight">AI Agent Platform</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                isActive ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"
              }`
            }
          >
            <Icon size={18} className="shrink-0" />
            {label}
          </NavLink>
        ))}
        {user?.isPlatformAdmin && (
          <NavLink
            to="/app/admin"
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                isActive ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"
              }`
            }
          >
            <Shield size={18} className="shrink-0" />
            Admin Panel
          </NavLink>
        )}
      </nav>

      <div className="px-4 py-4">
        <div className="rounded-xl border border-line bg-elevated p-3 text-xs text-muted">
          <span className="font-medium text-ink">Phase 1 foundation.</span> Integrations are wired up but not yet connected.
        </div>
      </div>
    </aside>
  );
}
