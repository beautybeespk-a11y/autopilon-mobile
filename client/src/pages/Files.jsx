import { useEffect, useRef, useState } from "react";
import {
  Upload, FolderPlus, Folder, FileText, Image as ImageIcon, FileSpreadsheet, Music, Video, Archive, File as FileIcon,
  Search, Grid, List, Star, Clock, Users, Trash2, ChevronRight, X, Download, Share2, History, Info, RotateCcw,
  AlertTriangle, Copy as CopyIcon, Link as LinkIcon, HardDrive,
} from "lucide-react";
import { Card, Input, Badge, EmptyState, Button } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

const TABS = [
  { id: "all", label: "My Files", icon: Folder },
  { id: "recent", label: "Recent", icon: Clock },
  { id: "favorites", label: "Favorites", icon: Star },
  { id: "shared", label: "Shared with me", icon: Users },
  { id: "trash", label: "Trash", icon: Trash2 },
];

const EXT_ICON = {
  pdf: FileText, doc: FileText, docx: FileText, txt: FileText, md: FileText,
  csv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
  ppt: FileText, pptx: FileText,
  jpg: ImageIcon, jpeg: ImageIcon, png: ImageIcon, webp: ImageIcon, gif: ImageIcon, svg: ImageIcon,
  mp3: Music, wav: Music, m4a: Music,
  mp4: Video, mov: Video,
  zip: Archive,
};

function iconFor(extension) {
  return EXT_ICON[(extension || "").toLowerCase()] || FileIcon;
}

function formatBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export default function Files() {
  const [tab, setTab] = useState("all");
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("list");
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState([]); // [{name, status: 'uploading'|'error', error?}]
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState(null); // file detail panel
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [usage, setUsage] = useState(null);
  const fileInputRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      if (tab === "all") {
        const [folderList, fileList, crumbs] = await Promise.all([
          api.get(`/files/folders?parentFolderId=${currentFolderId || ""}`),
          api.get(`/files?folderId=${currentFolderId || ""}${query ? `&q=${encodeURIComponent(query)}` : ""}`),
          currentFolderId ? api.get(`/files/folders/${currentFolderId}/breadcrumb`) : Promise.resolve([]),
        ]);
        setFolders(folderList);
        setFiles(fileList);
        setBreadcrumb(crumbs);
      } else {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        if (tab === "recent") params.set("recentOnly", "true");
        if (tab === "favorites") params.set("favoritesOnly", "true");
        if (tab === "shared") params.set("sharedWithMe", "true");
        if (tab === "trash") params.set("trashed", "true");
        setFolders([]);
        setFiles(await api.get(`/files?${params.toString()}`));
        setBreadcrumb([]);
      }
    } catch {
      setFiles([]);
      setFolders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tab, currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get("/files/usage").then(setUsage).catch(() => {}); }, []);

  const openFolder = (id) => { setCurrentFolderId(id); setSelected(null); };

  const onFiles = async (fileList) => {
    const arr = Array.from(fileList);
    for (const file of arr) {
      setUploading((prev) => [...prev, { name: file.name, status: "uploading" }]);
      try {
        const formData = new FormData();
        formData.append("file", file);
        if (currentFolderId) formData.append("folderId", currentFolderId);
        await api.upload("/files/upload", formData);
        setUploading((prev) => prev.filter((u) => u.name !== file.name));
        load();
        api.get("/files/usage").then(setUsage).catch(() => {});
      } catch (err) {
        setUploading((prev) => prev.map((u) => (u.name === file.name ? { ...u, status: "error", error: err.message } : u)));
      }
    }
  };

  const createFolder = async (name) => {
    if (!name?.trim()) return;
    await api.post("/files/folders", { name: name.trim(), parentFolderId: currentFolderId });
    setShowNewFolder(false);
    load();
  };

  const toggleFavorite = async (file) => {
    await api.patch(`/files/${file.id}`, { favorite: !file.favorite });
    load();
    if (selected?.id === file.id) setSelected({ ...selected, favorite: !file.favorite });
  };

  const trashFile = async (file) => {
    await api.del(`/files/${file.id}`);
    setSelected(null);
    load();
  };

  const restoreFile = async (file) => {
    await api.post(`/files/${file.id}/restore`, {});
    load();
  };

  const permanentlyDelete = async (file) => {
    if (!confirm(`Permanently delete "${file.filename}"? This cannot be undone.`)) return;
    await api.del(`/files/${file.id}/permanent`);
    setSelected(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Files</h1>
          <p className="mt-1 text-muted">Upload, organize, and ask AI about your documents.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowNewFolder(true)}><FolderPlus size={16} /> New folder</Button>
          <Button onClick={() => fileInputRef.current?.click()}><Upload size={16} /> Upload</Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
        </div>
      </div>

      {usage && (
        <Card className="flex flex-wrap items-center gap-4 p-4">
          <HardDrive size={18} className="shrink-0 text-accent" />
          <div className="min-w-[220px] flex-1">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{formatBytes(usage.usage.usedBytes)} used{usage.quota.limit ? ` of ${formatBytes(usage.quota.limit)}` : ""}</span>
              {usage.quota.limit && <span>{usage.quota.percentUsed}%</span>}
            </div>
            {usage.quota.limit && (
              <div className="mt-1 h-1.5 rounded-full bg-elevated">
                <div
                  className={`h-1.5 rounded-full ${usage.quota.percentUsed >= 90 ? "bg-red-500" : usage.quota.percentUsed >= 75 ? "bg-amber-500" : "bg-accent"}`}
                  style={{ width: `${Math.min(usage.quota.percentUsed, 100)}%` }}
                />
              </div>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted">{usage.usage.fileCount} file{usage.usage.fileCount === 1 ? "" : "s"}</span>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setCurrentFolderId(null); setSelected(null); }}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium ${tab === t.id ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"}`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-1 text-sm text-muted">
          <button onClick={() => openFolder(null)} className="hover:text-accent">My Files</button>
          {breadcrumb.map((b) => (
            <span key={b.id} className="flex items-center gap-1">
              <ChevronRight size={14} />
              <button onClick={() => openFolder(b.id)} className="hover:text-accent">{b.name}</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files by name or content…" className="pl-10" />
        </div>
        <button onClick={() => setViewMode("list")} className={`rounded-lg p-2 ${viewMode === "list" ? "bg-elevated text-accent" : "text-muted"}`}><List size={18} /></button>
        <button onClick={() => setViewMode("grid")} className={`rounded-lg p-2 ${viewMode === "grid" ? "bg-elevated text-accent" : "text-muted"}`}><Grid size={18} /></button>
      </div>

      {uploading.length > 0 && (
        <Card className="divide-y divide-line">
          {uploading.map((u) => (
            <div key={u.name} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3"><FileText size={18} className="text-muted" /><span className="text-sm font-medium">{u.name}</span></div>
              {u.status === "uploading" ? <Badge tone="warn">Uploading…</Badge> : <span className="flex items-center gap-1 text-xs text-red-500"><AlertTriangle size={12} /> {u.error}</span>}
            </div>
          ))}
        </Card>
      )}

      <label
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-8 text-center ${dragOver ? "border-accent bg-accent/5" : "border-line bg-surface/50 hover:border-accent/50"}`}
      >
        <Upload size={20} className="mb-2 text-accent" />
        <span className="text-sm font-medium">Drop files here or click to upload</span>
        <input type="file" multiple className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
      </label>

      {loading ? null : folders.length === 0 && files.length === 0 ? (
        <EmptyState icon={tab === "trash" ? Trash2 : Folder} title={tab === "trash" ? "Trash is empty" : "Nothing here yet"} description={tab === "all" ? "Upload a file or create a folder to get started." : "Nothing to show in this view yet."} />
      ) : viewMode === "list" ? (
        <Card className="divide-y divide-line">
          {folders.map((f) => (
            <button key={f.id} onClick={() => openFolder(f.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-elevated">
              <Folder size={18} className="shrink-0 text-accent" />
              <span className="flex-1 truncate text-sm font-medium">{f.name}</span>
              <ChevronRight size={16} className="text-muted" />
            </button>
          ))}
          {files.map((file) => {
            const Icon = iconFor(file.extension);
            return (
              <div key={file.id} className="flex items-center gap-3 px-5 py-3 hover:bg-elevated">
                <button onClick={() => setSelected(file)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Icon size={18} className="shrink-0 text-muted" />
                  <span className="truncate text-sm font-medium">{file.filename}</span>
                  {file.favorite ? <Star size={13} className="shrink-0 fill-amber-400 text-amber-400" /> : null}
                </button>
                <span className="hidden shrink-0 text-xs text-muted sm:block">{formatBytes(file.sizeBytes)}</span>
                <span className="hidden shrink-0 text-xs text-muted md:block">{formatDate(file.updatedAt)}</span>
                <FileRowActions file={file} tab={tab} onToggleFavorite={() => toggleFavorite(file)} onTrash={() => trashFile(file)} onRestore={() => restoreFile(file)} onPermanentDelete={() => permanentlyDelete(file)} onOpen={() => setSelected(file)} />
              </div>
            );
          })}
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {folders.map((f) => (
            <button key={f.id} onClick={() => openFolder(f.id)} className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface p-4 hover:border-accent/40">
              <Folder size={32} className="text-accent" />
              <span className="w-full truncate text-center text-xs font-medium">{f.name}</span>
            </button>
          ))}
          {files.map((file) => {
            const Icon = iconFor(file.extension);
            return (
              <button key={file.id} onClick={() => setSelected(file)} className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface p-4 hover:border-accent/40">
                {file.previewSupport && ["jpg", "jpeg", "png", "webp", "gif"].includes((file.extension || "").toLowerCase()) ? (
                  <img src={`/api/files/${file.id}/content`} alt="" className="h-14 w-14 rounded-lg object-cover" />
                ) : (
                  <Icon size={32} className="text-muted" />
                )}
                <span className="w-full truncate text-center text-xs font-medium">{file.filename}</span>
                {file.favorite ? <Star size={12} className="fill-amber-400 text-amber-400" /> : null}
              </button>
            );
          })}
        </div>
      )}

      {showNewFolder && <NewFolderModal onClose={() => setShowNewFolder(false)} onCreate={createFolder} />}
      {selected && (
        <FileDetailPanel
          file={selected}
          onClose={() => setSelected(null)}
          onChanged={(updated) => { setSelected(updated); load(); }}
          onTrash={() => trashFile(selected)}
        />
      )}
    </div>
  );
}

function FileRowActions({ file, tab, onToggleFavorite, onTrash, onRestore, onPermanentDelete, onOpen }) {
  if (tab === "trash") {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={onRestore} className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-accent" title="Restore"><RotateCcw size={16} /></button>
        <button onClick={onPermanentDelete} className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-red-500" title="Delete forever"><Trash2 size={16} /></button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button onClick={onToggleFavorite} className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-amber-500" title="Favorite">
        <Star size={16} className={file.favorite ? "fill-amber-400 text-amber-400" : ""} />
      </button>
      <a href={`/api/files/${file.id}/content`} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-accent" title="Download"><Download size={16} /></a>
      <button onClick={onOpen} className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-accent" title="Details"><Info size={16} /></button>
      <button onClick={onTrash} className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-red-500" title="Delete"><Trash2 size={16} /></button>
    </div>
  );
}

function NewFolderModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">New folder</h2>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" className="mt-4" onKeyDown={(e) => e.key === "Enter" && onCreate(name)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onCreate(name)} disabled={!name.trim()}>Create</Button>
        </div>
      </Card>
    </div>
  );
}

const PREVIEWABLE_INLINE = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "txt", "md", "csv", "pdf", "mp3", "wav", "m4a", "mp4"]);

function FileDetailPanel({ file, onClose, onChanged, onTrash }) {
  const [tab, setTab] = useState("preview");
  const [versions, setVersions] = useState([]);
  const [activity, setActivity] = useState([]);
  const [shares, setShares] = useState([]);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(file.filename);
  const [showShareForm, setShowShareForm] = useState(false);
  const [newToken, setNewToken] = useState(null);

  useEffect(() => {
    setNameDraft(file.filename);
    setTab("preview");
    setNewToken(null);
    api.get(`/files/${file.id}/versions`).then(setVersions).catch(() => {});
    api.get(`/files/${file.id}/activity`).then(setActivity).catch(() => {});
    api.get(`/files/${file.id}/shares`).then(setShares).catch(() => {});
  }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ext = (file.extension || "").toLowerCase();
  const Icon = iconFor(ext);
  const contentUrl = `/api/files/${file.id}/content`;

  const saveName = async () => {
    if (!nameDraft.trim() || nameDraft === file.filename) return setRenaming(false);
    const updated = await api.patch(`/files/${file.id}`, { filename: nameDraft.trim() });
    onChanged(updated);
    setRenaming(false);
  };

  const createShareLink = async ({ expiresAt, password }) => {
    const share = await api.post(`/files/${file.id}/shares`, { expiresAt: expiresAt || undefined, password: password || undefined });
    setNewToken(share.token);
    setShares(await api.get(`/files/${file.id}/shares`));
    setShowShareForm(false);
  };

  const revokeShare = async (shareId) => {
    await api.del(`/files/${file.id}/shares/${shareId}`);
    setShares(await api.get(`/files/${file.id}/shares`));
  };

  const restoreVersion = async (version) => {
    if (!confirm(`Restore version ${version}? This creates a new version on top — nothing is lost.`)) return;
    const updated = await api.post(`/files/${file.id}/versions/${version}/restore`, {});
    onChanged(updated);
    setVersions(await api.get(`/files/${file.id}/versions`));
  };

  const addToKnowledge = async () => {
    await api.post(`/files/${file.id}/add-to-knowledge`, {});
    alert(`"${file.filename}" was added to your Knowledge Library.`);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-surface p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon size={20} className="shrink-0 text-accent" />
            {renaming ? (
              <input
                autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1 text-sm font-medium outline-none focus:border-accent"
              />
            ) : (
              <button onClick={() => setRenaming(true)} className="truncate text-left text-sm font-semibold hover:text-accent" title="Click to rename">{file.filename}</button>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated"><X size={18} /></button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line pb-2 text-xs">
          {[["preview", "Preview"], ["details", "Details"], ["versions", "Versions"], ["sharing", "Sharing"], ["activity", "Activity"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`rounded-lg px-2.5 py-1.5 font-medium ${tab === id ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated"}`}>{label}</button>
          ))}
        </div>

        {tab === "preview" && (
          <div className="mt-4">
            {!file.previewSupport ? (
              <div className="rounded-xl border border-line bg-elevated p-6 text-center text-sm text-muted">
                Preview isn't available for .{ext || "this"} files. <a href={contentUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Download instead</a>.
              </div>
            ) : ["jpg", "jpeg", "png", "webp", "gif", "svg"].includes(ext) ? (
              <img src={contentUrl} alt={file.filename} className="w-full rounded-xl border border-line object-contain" />
            ) : ext === "pdf" ? (
              <iframe title={file.filename} src={contentUrl} className="h-[420px] w-full rounded-xl border border-line" />
            ) : ["txt", "md", "csv"].includes(ext) && file.extractedText ? (
              <pre className="max-h-[420px] overflow-auto rounded-xl border border-line bg-bg p-3 text-xs whitespace-pre-wrap">{file.extractedText.slice(0, 5000)}</pre>
            ) : ["mp3", "wav", "m4a"].includes(ext) ? (
              <audio controls src={contentUrl} className="w-full" />
            ) : ext === "mp4" ? (
              <video controls src={contentUrl} className="w-full rounded-xl" />
            ) : (
              <div className="rounded-xl border border-line bg-elevated p-6 text-center text-sm text-muted">
                No inline preview for this file yet. <a href={contentUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Download instead</a>.
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <a href={contentUrl} target="_blank" rel="noreferrer" className="flex-1"><Button variant="outline" className="w-full"><Download size={15} /> Download</Button></a>
              {file.textExtractionSupport && file.extractedText && (
                <Button variant="outline" onClick={addToKnowledge}><CopyIcon size={15} /> Add to Knowledge</Button>
              )}
            </div>
          </div>
        )}

        {tab === "details" && (
          <div className="mt-4 space-y-3 text-sm">
            <Row label="Size" value={formatBytes(file.sizeBytes)} />
            <Row label="Type" value={file.mimeType || `.${ext}`} />
            <Row label="Created" value={formatDate(file.createdAt)} />
            <Row label="Modified" value={formatDate(file.updatedAt)} />
            <Row label="Version" value={`v${file.version}`} />
            <Row label="Visibility" value={<VisibilityPicker file={file} onChanged={onChanged} />} />
            <Row label="Processing" value={<Badge tone={file.processingStatus === "ready" ? "accent" : file.processingStatus === "failed" ? "warn" : "muted"}>{file.processingStatus}</Badge>} />
            <Row label="AI analysis" value={<Badge tone={file.aiProcessingStatus === "ready" ? "accent" : "muted"}>{file.aiProcessingStatus}</Badge>} />
            <Row label="Security scan" value={<Badge tone="muted">{file.securityScanStatus.replace("_", " ")}</Badge>} />
            {file.tags?.length > 0 && (
              <div>
                <div className="text-xs text-muted">Tags</div>
                <div className="mt-1 flex flex-wrap gap-1.5">{file.tags.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}</div>
              </div>
            )}
            <div className="pt-2">
              <button onClick={onTrash} className="flex items-center gap-1.5 text-sm text-red-500 hover:underline"><Trash2 size={14} /> Move to Trash</button>
            </div>
          </div>
        )}

        {tab === "versions" && (
          <div className="mt-4 space-y-2">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center justify-between rounded-xl border border-line p-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">v{v.version}{v.version === file.version ? " (current)" : ""}</div>
                  <div className="truncate text-xs text-muted">{v.note} · {formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}</div>
                </div>
                {v.version !== file.version && (
                  <button onClick={() => restoreVersion(v.version)} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-accent" title="Restore this version"><History size={16} /></button>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "sharing" && (
          <div className="mt-4 space-y-3">
            {newToken && (
              <div className="rounded-xl border border-accent/30 bg-accent/10 p-3 text-xs">
                <div className="mb-1 font-medium text-accent">Link created — copy it now, it won't be shown again:</div>
                <code className="block truncate">{`${window.location.origin}/share/${newToken}`}</code>
              </div>
            )}
            {shares.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-xl border border-line p-3 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-medium"><LinkIcon size={13} /> {s.hasPassword ? "Password protected" : "Open link"}</div>
                  <div className="text-xs text-muted">{s.expiresAt ? `Expires ${formatDate(s.expiresAt)}` : "No expiry"} · {s.accessCount} view{s.accessCount === 1 ? "" : "s"}</div>
                </div>
                <button onClick={() => revokeShare(s.id)} className="shrink-0 text-xs text-red-500 hover:underline">Revoke</button>
              </div>
            ))}
            {showShareForm ? (
              <ShareForm onCancel={() => setShowShareForm(false)} onCreate={createShareLink} />
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setShowShareForm(true)}><Share2 size={15} /> Create share link</Button>
            )}
          </div>
        )}

        {tab === "activity" && (
          <div className="mt-4 space-y-2">
            {activity.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-2 border-b border-line pb-2 text-xs">
                <span className="capitalize">{a.action.replace(/_/g, " ")}{a.detail ? ` — ${a.detail}` : ""}</span>
                <span className="shrink-0 text-muted">{new Date(a.createdAt).toLocaleString()}</span>
              </div>
            ))}
            {activity.length === 0 && <p className="text-xs text-muted">No activity recorded yet.</p>}
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

function VisibilityPicker({ file, onChanged }) {
  const [busy, setBusy] = useState(false);
  const set = async (visibility) => {
    setBusy(true);
    try { onChanged(await api.patch(`/files/${file.id}/visibility`, { visibility })); } finally { setBusy(false); }
  };
  return (
    <select
      value={file.visibility}
      disabled={busy}
      onChange={(e) => set(e.target.value)}
      className="rounded-lg border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
    >
      <option value="private">Private</option>
      <option value="workspace">Workspace</option>
      <option value="organization">Organization</option>
      <option value="shared">Shared (explicit)</option>
    </select>
  );
}

function ShareForm({ onCancel, onCreate }) {
  const [expiresAt, setExpiresAt] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div className="rounded-xl border border-line p-3">
      <label className="block text-xs text-muted">Expires (optional)</label>
      <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
      <label className="mt-2 block text-xs text-muted">Password (optional)</label>
      <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank for no password" className="mt-1 w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onCreate({ expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, password })}>Create link</Button>
      </div>
    </div>
  );
}
