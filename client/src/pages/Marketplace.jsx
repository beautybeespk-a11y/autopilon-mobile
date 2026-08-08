import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Store, Search, Bot, Zap, MessageSquare, BookOpen } from "lucide-react";
import { Card, Button, Badge, Input, EmptyState } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TYPE_ICON = { agent: Bot, automation: Zap, prompt: MessageSquare, knowledge_pack: BookOpen };
const TYPE_LABEL = { agent: "Agent", automation: "Automation", prompt: "Prompt", knowledge_pack: "Knowledge Pack" };

export default function Marketplace() {
  const [assets, setAssets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("recent");
  const navigate = useNavigate();

  const load = () => {
    const params = new URLSearchParams({ sort });
    if (query) params.set("q", query);
    if (type) params.set("type", type);
    if (category) params.set("category", category);
    api.get(`/marketplace/assets?${params}`).then(setAssets).catch(() => {});
  };
  useEffect(() => { api.get("/marketplace/categories").then(setCategories).catch(() => {}); }, []);
  useEffect(load, [type, category, sort]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Marketplace</h1>
          <p className="mt-1 text-muted">Discover and publish reusable agents, automations, prompts, and knowledge packs.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/app/marketplace/installs")}>My installs</Button>
          <Button variant="outline" onClick={() => navigate("/app/marketplace/mine")}>My published assets</Button>
        </div>
      </div>

      <Card className="flex flex-wrap items-end gap-2 p-4">
        <div className="min-w-48 flex-1">
          <Input label="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search assets…" />
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm">
            <option value="recent">Recently added</option>
            <option value="popular">Most popular</option>
            <option value="top_rated">Top rated</option>
            <option value="trending">Trending</option>
          </select>
        </div>
        <Button onClick={load}><Search size={16} /></Button>
      </Card>

      {assets.length === 0 ? (
        <EmptyState icon={Store} title="No assets found" description="Try a different search or filter, or be the first to publish something." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((a) => {
            const Icon = TYPE_ICON[a.assetType] || Store;
            return (
              <Card key={a.id} className="cursor-pointer p-5" onClick={() => navigate(`/app/marketplace/${a.id}`)}>
                <div className="flex items-start justify-between">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={20} /></div>
                  <Badge tone="muted">{TYPE_LABEL[a.assetType]}</Badge>
                </div>
                <h3 className="mt-3 font-display font-semibold">{a.name}</h3>
                <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description || "No description."}</p>
                <div className="mt-3 flex items-center justify-between text-xs text-muted">
                  <span>{a.pricingType === "free" ? "Free" : `$${(a.priceCents / 100).toFixed(2)}`}</span>
                  <span>{a.downloadCount} installs</span>
                  {a.ratingCount > 0 && <span>★ {(a.ratingSum / a.ratingCount).toFixed(1)}</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
