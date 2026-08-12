import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Download, Lock, AlertTriangle, FileText } from "lucide-react";
import AuthShell from "./AuthShell.jsx";
import { Button } from "../components/ui/index.jsx";

function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Public — deliberately never touches the authenticated api.js client or
// the app Layout/sidebar. Anyone with the link (an Autopilon account or
// not) needs to be able to load this page and, once past any password,
// download the file — the same contract server/routes/fileShares.js
// implements.
export default function SharedFile() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then((r) => r.json())
      .then((data) => (data.valid ? setInfo(data) : setError("This link is invalid, expired, or has been revoked.")))
      .catch(() => setError("Couldn't load this link."));
  }, [token]);

  const download = async () => {
    setDownloading(true);
    setPasswordError(null);
    try {
      const res = await fetch(`/api/share/${token}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPasswordError(data.error || "Couldn't download this file.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = info.file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setPasswordError("Couldn't download this file.");
    } finally {
      setDownloading(false);
    }
  };

  if (error) {
    return (
      <AuthShell title="Shared file" subtitle="">
        <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-3 text-sm text-amber-500">
          <AlertTriangle size={16} /> {error}
        </div>
      </AuthShell>
    );
  }

  if (!info) {
    return (
      <AuthShell title="Shared file" subtitle="Loading…">
        <div />
      </AuthShell>
    );
  }

  return (
    <AuthShell title={info.file.filename} subtitle={formatBytes(info.file.sizeBytes)}>
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent"><FileText size={26} /></div>
        {info.requiresPassword && (
          <div className="w-full">
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-muted"><Lock size={14} /> Password</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && download()}
              className="w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-sm outline-none focus:border-accent"
            />
          </div>
        )}
        {passwordError && <p className="text-sm text-red-500">{passwordError}</p>}
        <Button className="w-full" onClick={download} disabled={downloading}>
          <Download size={16} /> {downloading ? "Downloading…" : "Download"}
        </Button>
      </div>
    </AuthShell>
  );
}
