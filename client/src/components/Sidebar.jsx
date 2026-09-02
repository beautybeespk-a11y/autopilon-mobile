import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Shield, MessageSquareText } from "lucide-react";
import { NAV } from "./nav-items.js";
import { useAuth } from "../lib/auth.jsx";
import FeedbackModal from "./FeedbackModal.jsx";
import { LogoMark } from "./Logo.jsx";

export default function Sidebar() {
  const { user } = useAuth();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <LogoMark size={32} />
        <span className="font-display text-[15px] font-semibold tracking-tight">Autopilon</span>
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
        <button
          onClick={() => setFeedbackOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-xl border border-line px-3 py-2.5 text-sm font-medium text-muted transition hover:border-accent/40 hover:text-ink"
        >
          <MessageSquareText size={16} className="shrink-0" />
          Give feedback
        </button>
      </div>
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </aside>
  );
}
