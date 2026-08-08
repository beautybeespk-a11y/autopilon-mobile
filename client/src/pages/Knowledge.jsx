import { useEffect, useRef, useState } from "react";
import { Upload, FileText, Search, BookMarked, Trash2, ExternalLink, Download, AlertTriangle } from "lucide-react";
import { Card, Input, EmptyState, Badge } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function Knowledge() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState([]); // [{name, progress: 'uploading'|'error', error?}]
  const fileInputRef = useRef(null);

  const load = () => api.get("/research/knowledge").then(setItems).catch(() => {}).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const savedResearch = items.filter((i) => i.type !== "document");
  const documents = items
    .filter((i) => i.type === "document")
    .filter((d) => d.title.toLowerCase().includes(query.toLowerCase()));

  const removeItem = async (id, title) => {
    if (!confirm(`Permanently delete "${title}"?`)) return;
    await api.del(`/research/knowledge/${id}`);
    load();
  };

  const onFiles = async (fileList) => {
    const files = Array.from(fileList);
    for (const file of files) {
      setUploading((prev) => [...prev, { name: file.name, status: "uploading" }]);
      try {
        const formData = new FormData();
        formData.append("file", file);
        await api.upload("/research/knowledge/upload", formData);
        setUploading((prev) => prev.filter((u) => u.name !== file.name));
        load();
      } catch (err) {
        setUploading((prev) => prev.map((u) => (u.name === file.name ? { ...u, status: "error", error: err.message } : u)));
      }
    }
  };

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-display text-2xl font-semibold">Knowledge</h1>
        <p className="mt-1 text-muted">Documents you upload, and research your agents have saved on your behalf.</p>
      </div>

      {/* Saved research */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <BookMarked size={18} className="text-accent" />
          <h2 className="font-display text-lg font-semibold">Saved research</h2>
        </div>
        {loading ? null : savedResearch.length === 0 ? (
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
                      {item.sourceUrls.slice(0, 3).map((s, i) => {
                        // sourceUrls items are sometimes bare strings rather
                        // than {title,url} objects — handle both.
                        const url = typeof s === "string" ? s : s.url;
                        const label = typeof s === "string" ? s : (s.title || s.url);
                        return (
                          <a key={i} href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted hover:text-accent">
                            <ExternalLink size={12} /> {label}
                          </a>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-xs text-muted">{new Date(item.createdAt).toLocaleDateString()}</div>
                </div>
                <button onClick={() => removeItem(item.id, item.title)} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* Uploaded documents — real upload, extracted text is searchable by
          agents via the same search_knowledge tool that reads this table. */}
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
          <span className="mt-1 text-sm text-muted">PDF, Word, or text files — their content becomes searchable by your agents.</span>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
        </label>

        <div className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files" className="pl-10" />
        </div>

        {uploading.length > 0 && (
          <Card className="mt-4 divide-y divide-line">
            {uploading.map((u) => (
              <div key={u.name} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <FileText size={18} className="text-muted" />
                  <span className="text-sm font-medium">{u.name}</span>
                </div>
                {u.status === "uploading" ? (
                  <Badge tone="warn">Uploading…</Badge>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-500"><AlertTriangle size={12} /> {u.error}</span>
                )}
              </div>
            ))}
          </Card>
        )}

        {loading ? null : documents.length === 0 && uploading.length === 0 ? (
          <div className="mt-4"><EmptyState icon={FileText} title="No files yet" description="Upload a document to build your knowledge base." /></div>
        ) : (
          documents.length > 0 && (
            <Card className="mt-4 divide-y divide-line">
              {documents.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText size={18} className="shrink-0 text-muted" />
                    <span className="truncate text-sm font-medium">{d.title}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <a
                      href={`/api/research/knowledge/${d.id}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-accent"
                      title="Download"
                    >
                      <Download size={16} />
                    </a>
                    <button onClick={() => removeItem(d.id, d.title)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-red-500" title="Delete">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </Card>
          )
        )}
      </div>
    </div>
  );
}
