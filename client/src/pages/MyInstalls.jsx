import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Zap, MessageSquare, BookOpen, Store, Trash2, RefreshCw, Power, PowerOff } from "lucide-react";
import { Card, Button, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TYPE_ICON = { agent: Bot, automation: Zap, prompt: MessageSquare, knowledge_pack: BookOpen, knowledge_item: BookOpen };

export default function MyInstalls() {
  const [installs, setInstalls] = useState([]);
  const navigate = useNavigate();

  const load = () => api.get("/marketplace/installs").then(setInstalls).catch(() => {});
  useEffect(load, []);

  const update = async (id) => { try { await api.post(`/marketplace/installs/${id}/update`, {}); load(); } catch (e) { alert(e.message); } };
  const toggle = async (i) => { await api.post(`/marketplace/installs/${i.id}/${i.status === "active" ? "disable" : "enable"}`, {}); load(); };
  const remove = async (id) => { await api.del(`/marketplace/installs/${id}`); load(); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">My Installed Assets</h1>
          <p className="mt-1 text-muted">Things you've installed from the Marketplace, and their versions.</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/app/marketplace")}>Browse Marketplace</Button>
      </div>

      {installs.length === 0 ? (
        <EmptyState icon={Store} title="Nothing installed yet" description="Install an asset from the Marketplace to see it here." />
      ) : (
        <Card className="divide-y divide-line">
          {installs.map((i) => {
            const Icon = TYPE_ICON[i.assetType] || Store;
            const behind = i.installedVersion !== i.latestVersion;
            return (
              <div key={i.id} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent"><Icon size={18} /></div>
                  <div>
                    <div className="font-medium">{i.assetName}</div>
                    <div className="text-xs text-muted">
                      v{i.installedVersion}{behind && ` (v${i.latestVersion} available)`} · {i.installedEntityType}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {i.status !== "uninstalled" && (
                    <Badge tone={i.status === "active" ? "success" : "muted"}>{i.status}</Badge>
                  )}
                  {behind && i.status !== "uninstalled" && i.installedEntityType !== "knowledge_item" && (
                    <button title="Update to latest" onClick={() => update(i.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink"><RefreshCw size={16} /></button>
                  )}
                  {i.status !== "uninstalled" && i.installedEntityType !== "knowledge_item" && (
                    <button title={i.status === "active" ? "Disable" : "Enable"} onClick={() => toggle(i)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-ink">
                      {i.status === "active" ? <PowerOff size={16} /> : <Power size={16} />}
                    </button>
                  )}
                  {i.status !== "uninstalled" && (
                    <button title="Uninstall" onClick={() => remove(i.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
