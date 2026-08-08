import { Moon, Sun, LogOut } from "lucide-react";
import { useTheme } from "../lib/theme.jsx";
import { useAuth } from "../lib/auth.jsx";
import NotificationBell from "./NotificationBell.jsx";

export default function Topbar() {
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();
  const initial = (user?.name || "?").charAt(0).toUpperCase();

  return (
    <header className="hidden items-center justify-end gap-2 border-b border-line bg-surface/70 px-6 py-3 backdrop-blur md:flex">
      <NotificationBell />
      <button onClick={toggle} className="rounded-xl p-2.5 text-muted hover:bg-elevated" aria-label="Toggle theme">
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <div className="ml-1 flex items-center gap-2.5 rounded-xl border border-line bg-bg px-2.5 py-1.5">
        <div className="grid h-7 w-7 place-items-center rounded-lg accent-gradient text-xs font-semibold text-white">{initial}</div>
        <span className="text-sm font-medium">{user?.name}</span>
        <button onClick={logout} className="rounded-lg p-1.5 text-muted hover:bg-elevated" aria-label="Log out">
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
