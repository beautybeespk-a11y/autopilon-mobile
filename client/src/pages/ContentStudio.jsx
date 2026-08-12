import { useEffect, useState } from "react";
import {
  Sparkles, Image as ImageIcon, Type, Mic, LayoutTemplate, Palette, Wand2, RefreshCw,
  Copy as CopyIcon, Star, Trash2, Download, X, Search, Plus, Loader2, AlertTriangle,
  FileText, Video, Music, CheckCircle2, RotateCcw,
} from "lucide-react";
import { Card, Input, Textarea, Badge, EmptyState, Button } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TABS = [
  { id: "library", label: "Content Library", icon: LayoutTemplate },
  { id: "create", label: "Create", icon: Sparkles },
  { id: "templates", label: "Templates", icon: FileText },
  { id: "brands", label: "Brand Voice", icon: Palette },
];

const TYPE_ICON = {
  image: ImageIcon, video: Video, audio: Music, voiceover: Mic, music: Music,
};
function iconForType(t) {
  return TYPE_ICON[t] || Type;
}
function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}
const VOICES = [
  { id: "alloy", label: "Alloy" }, { id: "echo", label: "Echo" }, { id: "fable", label: "Fable" },
  { id: "onyx", label: "Onyx" }, { id: "nova", label: "Nova" }, { id: "shimmer", label: "Shimmer" },
];

export default function ContentStudio() {
  const [tab, setTab] = useState("library");
  const [status, setStatus] = useState(null);

  useEffect(() => { api.get("/content/status").then(setStatus).catch(() => {}); }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">AI Content Studio</h1>
          <p className="mt-1 text-muted">Generate and manage images, copy, and voiceovers — all saved to your Files &amp; Document library.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium ${tab === t.id ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"}`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "library" && <LibraryTab status={status} />}
      {tab === "create" && <CreateTab status={status} />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "brands" && <BrandsTab />}
    </div>
  );
}

// ---------------- Library ----------------

function LibraryTab({ status }) {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [contentType, setContentType] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [trashed, setTrashed] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (contentType) params.set("contentType", contentType);
      if (favoritesOnly) params.set("favoritesOnly", "true");
      if (trashed) params.set("trashed", "true");
      setAssets(await api.get(`/content?${params.toString()}`));
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [query, contentType, favoritesOnly, trashed]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFavorite = async (asset) => {
    await api.patch(`/content/${asset.id}`, { favorite: !asset.favorite });
    load();
    if (selected?.id === asset.id) setSelected({ ...selected, favorite: !asset.favorite });
  };

  const trashAsset = async (asset) => {
    await api.del(`/content/${asset.id}`);
    setSelected(null);
    load();
  };

  const restoreAsset = async (asset) => {
    await api.post(`/content/${asset.id}/restore`, {});
    load();
  };

  const permanentlyDelete = async (asset) => {
    if (!confirm(`Permanently delete "${asset.title}"? This cannot be undone.`)) return;
    await api.del(`/content/${asset.id}/permanent`);
    setSelected(null);
    load();
  };

  const duplicate = async (asset) => {
    await api.post(`/content/${asset.id}/duplicate`, {});
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search content…" className="pl-10" />
        </div>
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="voiceover">Voiceovers</option>
          <option value="caption">Captions</option>
          <option value="ad_copy">Ad copy</option>
          <option value="product_description">Product descriptions</option>
          <option value="blog">Blog posts</option>
          <option value="email">Emails</option>
          <option value="headline">Headlines</option>
          <option value="hook">Hooks</option>
          <option value="cta">CTAs</option>
          <option value="script">Scripts</option>
          <option value="seo_content">SEO content</option>
          <option value="ugc_script">UGC scripts</option>
        </select>
        <button onClick={() => setFavoritesOnly((v) => !v)} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium ${favoritesOnly ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-elevated"}`}>
          <Star size={15} className={favoritesOnly ? "fill-accent" : ""} /> Favorites
        </button>
        <button onClick={() => setTrashed((v) => !v)} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium ${trashed ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-elevated"}`}>
          <Trash2 size={15} /> Trash
        </button>
      </div>

      {loading ? null : assets.length === 0 ? (
        <EmptyState icon={Sparkles} title={trashed ? "Trash is empty" : "No content yet"} description={trashed ? "Nothing here." : "Head to Create to generate your first image, caption, or voiceover."} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {assets.map((asset) => {
            const Icon = iconForType(asset.contentType);
            return (
              <button key={asset.id} onClick={() => setSelected(asset)} className="flex flex-col items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left hover:border-accent/40">
                {asset.contentType === "image" && asset.fileId ? (
                  <img src={`/api/files/${asset.fileId}/content`} alt="" className="h-28 w-full rounded-lg object-cover" />
                ) : (
                  <div className="grid h-28 w-full place-items-center rounded-lg bg-elevated">
                    <Icon size={28} className="text-muted" />
                  </div>
                )}
                <span className="w-full truncate text-xs font-medium">{asset.title}</span>
                <div className="flex w-full items-center justify-between gap-1">
                  <Badge tone={asset.status === "ready" ? "success" : asset.status === "failed" ? "warn" : "muted"}>{asset.status}</Badge>
                  {asset.favorite ? <Star size={12} className="fill-amber-400 text-amber-400" /> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <AssetDetailPanel
          asset={selected}
          onClose={() => setSelected(null)}
          onChanged={(updated) => { setSelected(updated); load(); }}
          onToggleFavorite={() => toggleFavorite(selected)}
          onTrash={() => trashAsset(selected)}
          onRestore={() => restoreAsset(selected)}
          onPermanentDelete={() => permanentlyDelete(selected)}
          onDuplicate={() => duplicate(selected)}
        />
      )}
    </div>
  );
}

function AssetDetailPanel({ asset, onClose, onChanged, onToggleFavorite, onTrash, onRestore, onPermanentDelete, onDuplicate }) {
  const [panelTab, setPanelTab] = useState("preview");
  const [versions, setVersions] = useState([]);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState("");

  useEffect(() => {
    setPanelTab("preview");
    api.get(`/content/${asset.id}/versions`).then(setVersions).catch(() => setVersions([]));
  }, [asset.id]);

  const Icon = iconForType(asset.contentType);
  const isImage = asset.contentType === "image";
  const isAudio = asset.contentType === "voiceover" || asset.contentType === "audio" || asset.contentType === "music";
  const fileUrl = asset.fileId ? `/api/files/${asset.fileId}/content` : null;

  const regenerate = async () => {
    setRegenBusy(true);
    try {
      const updated = await api.post(`/content/${asset.id}/regenerate`, { prompt: regenPrompt || undefined });
      onChanged(updated);
      setVersions(await api.get(`/content/${asset.id}/versions`));
      setRegenPrompt("");
    } catch (err) {
      alert(err.detail || err.message);
    } finally {
      setRegenBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-surface p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon size={20} className="shrink-0 text-accent" />
            <span className="truncate text-sm font-semibold">{asset.title}</span>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated"><X size={18} /></button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line pb-2 text-xs">
          {[["preview", "Preview"], ["details", "Details"], ["versions", "Versions"]].map(([id, label]) => (
            <button key={id} onClick={() => setPanelTab(id)} className={`rounded-lg px-2.5 py-1.5 font-medium ${panelTab === id ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated"}`}>{label}</button>
          ))}
        </div>

        {panelTab === "preview" && (
          <div className="mt-4 space-y-3">
            {asset.status === "failed" && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-600">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{asset.errorMessage || "Generation failed."}</span>
              </div>
            )}
            {isImage && fileUrl ? (
              <img src={fileUrl} alt={asset.title} className="w-full rounded-xl border border-line object-contain" />
            ) : isAudio && fileUrl ? (
              <audio controls src={fileUrl} className="w-full" />
            ) : asset.textContent ? (
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg p-3 text-xs">{asset.textContent}</pre>
            ) : (
              <div className="rounded-xl border border-line bg-elevated p-6 text-center text-sm text-muted">Nothing to preview yet.</div>
            )}

            <div className="flex flex-wrap gap-2">
              {fileUrl && (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="flex-1"><Button variant="outline" className="w-full"><Download size={15} /> Download</Button></a>
              )}
              <Button variant="outline" onClick={onDuplicate}><CopyIcon size={15} /> Duplicate</Button>
              <Button variant="outline" onClick={onToggleFavorite}><Star size={15} className={asset.favorite ? "fill-amber-400 text-amber-400" : ""} /> {asset.favorite ? "Favorited" : "Favorite"}</Button>
            </div>

            {isImage && (
              <div className="rounded-xl border border-line p-3">
                <div className="text-xs font-medium text-muted">Regenerate</div>
                <Textarea value={regenPrompt} onChange={(e) => setRegenPrompt(e.target.value)} placeholder="Leave blank to reuse the last prompt, or describe what to change…" className="mt-2 min-h-[70px]" />
                <Button className="mt-2 w-full" onClick={regenerate} disabled={regenBusy}>
                  {regenBusy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Regenerate (new version)
                </Button>
              </div>
            )}

            {asset.trashedAt ? (
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onRestore}><RotateCcw size={15} /> Restore</Button>
                <Button variant="outline" className="flex-1 text-red-500" onClick={onPermanentDelete}><Trash2 size={15} /> Delete forever</Button>
              </div>
            ) : (
              <button onClick={onTrash} className="flex items-center gap-1.5 text-sm text-red-500 hover:underline"><Trash2 size={14} /> Move to Trash</button>
            )}
          </div>
        )}

        {panelTab === "details" && (
          <div className="mt-4 space-y-3 text-sm">
            <Row label="Type" value={asset.contentType} />
            <Row label="Status" value={<Badge tone={asset.status === "ready" ? "success" : asset.status === "failed" ? "warn" : "muted"}>{asset.status}</Badge>} />
            <Row label="Version" value={`v${asset.currentVersion}`} />
            <Row label="Created" value={formatDate(asset.createdAt)} />
            <Row label="Updated" value={formatDate(asset.updatedAt)} />
            {asset.linkedCampaignId && <Row label="Linked campaign" value={asset.linkedCampaignId} />}
          </div>
        )}

        {panelTab === "versions" && (
          <div className="mt-4 space-y-2">
            {versions.map((v) => (
              <div key={v.id} className="rounded-xl border border-line p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">v{v.version}{v.version === asset.currentVersion ? " (current)" : ""}</span>
                  <Badge tone={v.status === "ready" ? "success" : v.status === "failed" ? "warn" : "muted"}>{v.status}</Badge>
                </div>
                {v.prompt && <div className="mt-1 truncate text-xs text-muted">{v.prompt}</div>}
                <div className="mt-1 text-xs text-muted">{v.provider ? `${v.provider}${v.model ? ` · ${v.model}` : ""} · ` : ""}{formatDate(v.createdAt)}</div>
              </div>
            ))}
            {versions.length === 0 && <p className="text-xs text-muted">No version history yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}

// ---------------- Create ----------------

function CreateTab({ status }) {
  const [createType, setCreateType] = useState("image");
  const types = [
    { id: "image", label: "Image", icon: ImageIcon },
    { id: "copy", label: "Copywriter", icon: Type },
    { id: "voiceover", label: "Voiceover", icon: Mic },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {types.map((t) => (
          <button
            key={t.id}
            onClick={() => setCreateType(t.id)}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-medium ${createType === t.id ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-elevated"}`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {createType === "image" && <ImageCreateForm status={status?.image?.default} />}
      {createType === "copy" && <CopyCreateForm />}
      {createType === "voiceover" && <VoiceoverCreateForm />}
    </div>
  );
}

function ProviderNotice({ status }) {
  if (!status) return null;
  if (status.configured) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-600">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span>Provider not configured{status.reason ? ` — ${status.reason}` : ""}. Generation will fail until an API key is added on the server.</span>
    </div>
  );
}

function ImageCreateForm({ status }) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [numImages, setNumImages] = useState(1);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { assets } = await api.post("/content/generate/image", { prompt, size, numImages, title: title || undefined });
      setResult(assets);
    } catch (err) {
      setError(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-xl p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted"><Wand2 size={16} /> Generate an image {status?.capabilities?.estimatedCostCentsPerImage ? `· ~${status.capabilities.estimatedCostCentsPerImage}¢/image` : ""}</div>
      <ProviderNotice status={status} />
      <Textarea label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A minimalist product shot of a ceramic mug on a wooden table, soft morning light…" className="mt-3 min-h-[100px]" />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Size</span>
          <select value={size} onChange={(e) => setSize(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
            <option value="1024x1024">Square (1024×1024)</option>
            <option value="1536x1024">Landscape (1536×1024)</option>
            <option value="1024x1536">Portrait (1024×1536)</option>
          </select>
        </label>
        <Input label="How many" type="number" min={1} max={10} value={numImages} onChange={(e) => setNumImages(Number(e.target.value) || 1)} />
      </div>
      <Input label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-3" />
      <Button className="mt-4 w-full" onClick={generate} disabled={busy || !prompt.trim()}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Generate
      </Button>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-1.5 text-sm text-accent"><CheckCircle2 size={15} /> Saved to your Content Library</div>
          <div className="grid grid-cols-3 gap-2">
            {result.map((a) => (
              <img key={a.id} src={`/api/files/${a.fileId}/content`} alt="" className="h-20 w-full rounded-lg border border-line object-cover" />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function CopyCreateForm() {
  const [copyTypes, setCopyTypes] = useState([]);
  const [brands, setBrands] = useState([]);
  const [contentType, setContentType] = useState("caption");
  const [brief, setBrief] = useState("");
  const [brandId, setBrandId] = useState("");
  const [tone, setTone] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get("/content/copy-types").then((types) => { setCopyTypes(types); if (types[0]) setContentType(types[0].id); }).catch(() => {});
    api.get("/content/brands").then(setBrands).catch(() => {});
  }, []);

  const generate = async () => {
    if (!brief.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const asset = await api.post("/content/generate/copy", {
        contentType, brief, brandId: brandId || undefined, tone: tone || undefined,
        targetAudience: targetAudience || undefined, title: title || undefined,
      });
      setResult(asset);
    } catch (err) {
      setError(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-xl p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted"><Type size={16} /> AI Copywriter</div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-muted">What to write</span>
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
          {copyTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <Textarea label="Brief" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What is this for? Include any key details, product info, or offer…" className="mt-3 min-h-[100px]" />
      {brands.length > 0 && (
        <label className="mt-3 block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Brand voice (optional)</span>
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
            <option value="">None</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Input label="Tone (optional)" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Playful, formal…" />
        <Input label="Audience (optional)" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="New parents…" />
      </div>
      <Input label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-3" />
      <Button className="mt-4 w-full" onClick={generate} disabled={busy || !brief.trim()}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Generate
      </Button>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-1.5 text-sm text-accent"><CheckCircle2 size={15} /> Saved to your Content Library</div>
          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg p-3 text-xs">{result.textContent}</pre>
        </div>
      )}
    </Card>
  );
}

function VoiceoverCreateForm() {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const generate = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const asset = await api.post("/content/generate/voiceover", { text, voice, title: title || undefined });
      setResult(asset);
    } catch (err) {
      setError(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-xl p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted"><Mic size={16} /> Generate a voiceover</div>
      <Textarea label="Script" value={text} onChange={(e) => setText(e.target.value)} placeholder="What should the voiceover say?" className="mt-1 min-h-[120px]" maxLength={4000} />
      <label className="mt-3 block">
        <span className="mb-1.5 block text-sm font-medium text-muted">Voice</span>
        <select value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
          {VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </label>
      <Input label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-3" />
      <Button className="mt-4 w-full" onClick={generate} disabled={busy || !text.trim()}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Generate
      </Button>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-1.5 text-sm text-accent"><CheckCircle2 size={15} /> Saved to your Content Library</div>
          {result.fileId && <audio controls src={`/api/files/${result.fileId}/content`} className="w-full" />}
        </div>
      )}
    </Card>
  );
}

// ---------------- Templates ----------------

function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [applying, setApplying] = useState(null);

  const load = () => api.get("/content/templates").then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}><Plus size={16} /> New template</Button>
      </div>
      {templates.length === 0 ? (
        <EmptyState icon={FileText} title="No templates yet" description="Platform templates will appear here." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{t.name}</span>
                {t.isPlatform ? <Badge tone="accent">Platform</Badge> : <Badge tone="muted">Custom</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted">{t.description}</p>
              <div className="mt-2"><Badge tone="muted">{t.contentType}</Badge></div>
              <Button variant="outline" className="mt-3 w-full" onClick={() => setApplying(t)}><Sparkles size={15} /> Use template</Button>
            </Card>
          ))}
        </div>
      )}
      {showNew && <NewTemplateModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {applying && <ApplyTemplateModal template={applying} onClose={() => setApplying(null)} />}
    </div>
  );
}

function NewTemplateModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contentType, setContentType] = useState("caption");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || !promptTemplate.trim()) return;
    setBusy(true);
    try {
      await api.post("/content/templates", { name, description, contentType, promptTemplate });
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">New template</h2>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} className="mt-3" />
        <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="mt-3" />
        <label className="mt-3 block">
          <span className="mb-1.5 block text-sm font-medium text-muted">Content type</span>
          <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none focus:border-accent">
            {["caption", "hashtags", "ad_copy", "product_description", "blog", "email", "headline", "hook", "cta", "script", "seo_content", "ugc_script"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <Textarea label="Prompt template" value={promptTemplate} onChange={(e) => setPromptTemplate(e.target.value)} placeholder="Write a caption for {{product}} highlighting {{benefit}}…" className="mt-3 min-h-[90px]" />
        <p className="mt-1 text-xs text-muted">Use {"{{placeholders}}"} for anything that should be filled in when the template is used.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy || !name.trim() || !promptTemplate.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : "Create"}</Button>
        </div>
      </Card>
    </div>
  );
}

function ApplyTemplateModal({ template, onClose }) {
  const placeholders = Array.from(new Set([...template.promptTemplate.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])));
  const [values, setValues] = useState(Object.fromEntries(placeholders.map((p) => [p, ""])));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const asset = await api.post("/content/generate/copy", {
        contentType: template.contentType, templateId: template.id, templateVariables: values, brief: template.promptTemplate,
      });
      setResult(asset);
    } catch (err) {
      setError(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">{template.name}</h2>
        <p className="mt-1 text-xs text-muted">{template.description}</p>
        {placeholders.length > 0 ? (
          <div className="mt-3 space-y-2">
            {placeholders.map((p) => (
              <Input key={p} label={p} value={values[p]} onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">This template has no placeholders to fill in.</p>
        )}
        <Button className="mt-4 w-full" onClick={run} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Generate</Button>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {result && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-1.5 text-sm text-accent"><CheckCircle2 size={15} /> Saved to your Content Library</div>
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg p-3 text-xs">{result.textContent}</pre>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------- Brand Voice ----------------

function BrandsTab() {
  const [brands, setBrands] = useState([]);
  const [editing, setEditing] = useState(null); // brand object, or {} for new

  const load = () => api.get("/content/brands").then(setBrands).catch(() => setBrands([]));
  useEffect(() => { load(); }, []);

  const remove = async (brand) => {
    if (!confirm(`Delete brand voice "${brand.name}"?`)) return;
    await api.del(`/content/brands/${brand.id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing({})}><Plus size={16} /> New brand voice</Button>
      </div>
      {brands.length === 0 ? (
        <EmptyState icon={Palette} title="No brand voices yet" description="Define a brand voice so generated copy stays on-brand." action={<Button onClick={() => setEditing({})}><Plus size={16} /> New brand voice</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{b.name}</span>
                <button onClick={() => remove(b)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500"><Trash2 size={15} /></button>
              </div>
              {b.description && <p className="mt-1 text-xs text-muted">{b.description}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {b.tone && <Badge tone="muted">Tone: {b.tone}</Badge>}
                {b.targetAudience && <Badge tone="muted">Audience: {b.targetAudience}</Badge>}
              </div>
              <Button variant="outline" className="mt-3 w-full" onClick={() => setEditing(b)}>Edit</Button>
            </Card>
          ))}
        </div>
      )}
      {editing && <BrandModal brand={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function BrandModal({ brand, onClose, onSaved }) {
  const isNew = !brand.id;
  const [name, setName] = useState(brand.name || "");
  const [description, setDescription] = useState(brand.description || "");
  const [tone, setTone] = useState(brand.tone || "");
  const [writingStyle, setWritingStyle] = useState(brand.writingStyle || "");
  const [targetAudience, setTargetAudience] = useState(brand.targetAudience || "");
  const [preferredWords, setPreferredWords] = useState((brand.preferredWords || []).join(", "));
  const [avoidWords, setAvoidWords] = useState((brand.avoidWords || []).join(", "));
  const [ctaStyle, setCtaStyle] = useState(brand.ctaStyle || "");
  const [guidelines, setGuidelines] = useState(brand.guidelines || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const payload = {
      name, description, tone, writingStyle, targetAudience, ctaStyle, guidelines,
      preferredWords: preferredWords.split(",").map((w) => w.trim()).filter(Boolean),
      avoidWords: avoidWords.split(",").map((w) => w.trim()).filter(Boolean),
    };
    try {
      if (isNew) await api.post("/content/brands", payload);
      else await api.patch(`/content/brands/${brand.id}`, payload);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">{isNew ? "New brand voice" : "Edit brand voice"}</h2>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} className="mt-3" />
        <Textarea label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="mt-3" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Input label="Tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Warm, confident…" />
          <Input label="Writing style" value={writingStyle} onChange={(e) => setWritingStyle(e.target.value)} placeholder="Short sentences…" />
        </div>
        <Input label="Target audience" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} className="mt-3" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Input label="Favor these words" value={preferredWords} onChange={(e) => setPreferredWords(e.target.value)} placeholder="comma, separated" />
          <Input label="Avoid these words" value={avoidWords} onChange={(e) => setAvoidWords(e.target.value)} placeholder="comma, separated" />
        </div>
        <Input label="Preferred CTA style" value={ctaStyle} onChange={(e) => setCtaStyle(e.target.value)} className="mt-3" />
        <Textarea label="Additional guidelines (optional)" value={guidelines} onChange={(e) => setGuidelines(e.target.value)} className="mt-3" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : "Save"}</Button>
        </div>
      </Card>
    </div>
  );
}
