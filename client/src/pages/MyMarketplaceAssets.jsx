import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Zap, MessageSquare, BookOpen, Store, Trash2 } from "lucide-react";
import { Card, Button, Badge, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TYPE_ICON = { agent: Bot, automation: Zap, prompt: MessageSquare, knowledge_pack: BookOpen };
const TYPE_LABEL = { agent: "Agent", automation: "Automation", prompt: "Prompt", knowledge_pack: "Knowledge Pack" };

export default function MyMarketplaceAssets() {
  const [assets, setAssets] = useState([]);
  const navigate = useNavigate();

  const load = () => api.get("/marketplace/my-assets").then(setAssets).catch(() => {});
  useEffect(load, []);

  const publish = async (id) => { await api.post(`/marketplace/assets/${id}/publish`, {}); load(); };
  const unpublish = async (id) => { await api.post(`/marketplace/assets/${id}/unpublish`, {}); load(); };
  const remove = async (id) => { await api.del(`/marketplace/assets/${id}`); load(); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">My Published Assets</h1>
          <p className="mt-1 text-muted">Manage your marketplace listings — drafts, published, and unpublished.</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/app/marketplace")}>Browse Marketplace</Button>
      </div>
      <Button variant="outline" onClick={() => navigate("/app/marketplace/creator-dashboard")}>View Creator Dashboard</Button>

      {assets.length === 0 ? (
        <EmptyState icon={Store} title="Nothing published yet" description="Publish an agent or automation from its page to list it here." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((a) => {
            const Icon = TYPE_ICON[a.assetType] || Store;
            return (
              <Card key={a.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={20} /></div>
                  <button onClick={() => remove(a.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={16} /></button>
                </div>
                <h3 className="mt-3 cursor-pointer font-display font-semibold hover:underline" onClick={() => navigate(`/app/marketplace/${a.id}`)}>{a.name}</h3>
                <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description || "No description."}</p>
                <div className="mt-3 flex items-center gap-2">
                  <Badge tone="muted">{TYPE_LABEL[a.assetType]}</Badge>
                  <Badge tone={a.status === "published" ? "success" : "muted"}>{a.status}</Badge>
                  <span className="text-xs text-muted">v{a.latestVersion?.version}</span>
                </div>
                <div className="mt-4">
                  {a.status === "published" ? (
                    <Button variant="outline" className="w-full" onClick={() => unpublish(a.id)}>Unpublish</Button>
                  ) : (
                    <Button className="w-full" onClick={() => publish(a.id)}>Publish</Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
