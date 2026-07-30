import { useEffect, useState } from "react";
import { Sun, Moon, ShieldCheck, Cpu, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, Button } from "../components/ui/index.jsx";
import { useTheme } from "../lib/theme.jsx";
import { useAuth } from "../lib/auth.jsx";
import { api } from "../lib/api.js";

export default function Settings() {
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();
  const [provider, setProvider] = useState(null);

  useEffect(() => { api.get("/chat/provider-status").then(setProvider).catch(() => {}); }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-muted">Manage your workspace preferences.</p>
      </div>

      <Card className="p-6">
        <h2 className="font-display font-semibold">Account</h2>
        <div className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted">Name</span><span>{user?.name}</span></div>
          <div className="flex justify-between"><span className="text-muted">Email</span><span>{user?.email}</span></div>
        </div>
        <div className="mt-4"><Button variant="outline" onClick={logout}>Log out</Button></div>
      </Card>

      <Card className="p-6">
        <h2 className="font-display font-semibold">Appearance</h2>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-muted">Theme</span>
          <button onClick={toggle} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
            {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />} {theme === "dark" ? "Dark" : "Light"}
          </button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2"><Cpu size={18} className="text-accent" /><h2 className="font-display font-semibold">AI provider</h2></div>
        {provider ? (
          provider.configured ? (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent2/30 bg-accent2/10 px-3 py-2.5 text-sm text-accent2">
              <CheckCircle2 size={16} /> {provider.label} is configured and ready.
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-sm text-amber-500">
              <AlertTriangle size={16} /> AI provider not configured — {provider.reason}
            </div>
          )
        ) : (
          <p className="mt-3 text-sm text-muted">Checking provider status…</p>
        )}
        <p className="mt-3 text-xs text-muted">Provider and API keys are set on the server via environment variables. Keys are never exposed to the browser.</p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2"><ShieldCheck size={18} className="text-accent" /><h2 className="font-display font-semibold">Security</h2></div>
        <ul className="mt-3 space-y-1.5 text-sm text-muted">
          <li>Authenticated routes are protected server-side.</li>
          <li>Sessions use httpOnly cookies; passwords are hashed.</li>
          <li>You can only access your own data.</li>
        </ul>
      </Card>
    </div>
  );
}
