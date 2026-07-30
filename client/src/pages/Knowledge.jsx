import { useEffect, useState } from "react";
import { Upload, FileText, Search, BookMarked, Trash2, ExternalLink } from "lucide-react";
import { Card, Input, EmptyState, Badge } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

// Phase 1: local file staging only (no processing pipeline yet).
// Phase 3: real saved research from the Knowledge Library (server-backed).
export default function Knowledge() {
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState("");
  const [savedResearch, setSavedResearch] = useState([]);
  const [loadingResearch, setLoadingResearch] = useState(true);

  const loadResearch = () =>
    api.get("/research/knowledge").then(setSavedResearch).catch(() => {}).finally(() => setLoadingResearch(false));

  useEffect(() => { loadResearch(); }, []);

  const onFiles = (list) => {
    const added = Array.from(list).map((f) => ({ id: crypto.randomUUID(), name: f.name, size: f.size, status: "pending" }));
    setFiles((prev) => [...added, ...prev]);
  };

  const removeResearch = async (id) => {
    if (!confirm("Permanently delete this saved research item?")) return;
    await api.del(`/research/knowledge/${id}`);
    loadResearch();
  };

  const shownFiles = files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-display text-2xl font-semibold">Knowledge</h1>
        <p className="mt-1 text-muted">Documents you upload, and research your agents have saved on your behalf.</p>
      </div>

      {/* Saved research — Phase 3, real data */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <BookMarked size={18} className="text-accent" />
          <h2 className="font-display text-lg font-semibold">Saved research</h2>
        </div>
        {loadingResearch ? null : savedResearch.length === 0 ? (
          <EmptyState
            icon={BookMarked}
            title="Nothing saved yet"
            description={'Ask an agent with the Research skill enabled to look something up — e.g. "Research the latest skincare trends in Pakistan." When it offers to save the report, approving it will add it here.'}
          />
        ) : (
          <Card className="divide-y divide-line">
            {savedResearch.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.title}</span>
                    <Badge>{item.category || item.type}</Badge>
                  </div>
                  {item.tags?.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {item.tags.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}
                    </div>
                  )}
                  {item.sourceUrls?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {item.sourceUrls.slice(0, 3).map((s, i) => (
                        <a key={i} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted hover:text-accent">
                          <ExternalLink size={12} /> {s.title || s.url}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-xs text-muted">{new Date(item.createdAt).toLocaleDateString()}</div>
                </div>
                <button onClick={() => removeResearch(item.id)} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* File uploads — Phase 1 placeholder, unchanged */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <FileText size={18} className="text-accent" />
          <h2 className="font-display text-lg font-semibold">Uploaded documents</h2>
        </div>
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-12 text-center hover:border-accent/50"
        >
          <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-accent/10 text-accent"><Upload size={24} /></div>
          <span className="font-medium">Drop files here or click to upload</span>
          <span className="mt-1 text-sm text-muted">Files are staged now; processing is enabled in a later phase.</span>
          <input type="file" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
        </label>

        <div className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files" className="pl-10" />
        </div>

        {shownFiles.length === 0 ? (
          <div className="mt-4"><EmptyState icon={FileText} title="No files yet" description="Upload a document to build your knowledge base." /></div>
        ) : (
          <Card className="mt-4 divide-y divide-line">
            {shownFiles.map((f) => (
              <div key={f.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <FileText size={18} className="text-muted" />
                  <span className="text-sm font-medium">{f.name}</span>
                  <span className="font-mono text-xs text-muted">{(f.size / 1024).toFixed(0)} KB</span>
                </div>
                <Badge tone="warn">Pending</Badge>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
