import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Package, Download, Star, MessageSquare, DollarSign } from "lucide-react";
import { Card, Button, Badge } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

function StatCard({ icon: Icon, label, value, sub }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted"><Icon size={16} /><span className="text-xs font-medium">{label}</span></div>
      <div className="mt-2 font-display text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

export default function CreatorDashboard() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.get("/marketplace/creator-dashboard").then(setData).catch(() => {}); }, []);

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Creator Dashboard</h1>
          <p className="mt-1 text-muted">How your published Marketplace assets are doing.</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/app/marketplace/mine")}>Manage listings</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Package} label="Published assets" value={data.publishedCount} sub={`${data.draftCount} drafts`} />
        <StatCard icon={Download} label="Total installs" value={data.totalDownloads} />
        <StatCard icon={Star} label="Average rating" value={data.avgRating != null ? `★ ${data.avgRating}` : "—"} sub={`${data.totalReviews} reviews`} />
        <StatCard icon={DollarSign} label="Revenue" value={`$${((data.revenue?.netCents || 0) / 100).toFixed(2)}`} sub={`${data.revenue?.saleCount || 0} sales, net of platform commission`} />
      </div>

      <Card className="p-5">
        <h3 className="font-display font-semibold">Your assets</h3>
        <table className="mt-3 w-full text-left text-sm">
          <thead><tr className="border-b border-line text-xs text-muted">
            <th className="py-2 font-medium">Name</th><th className="py-2 font-medium">Status</th>
            <th className="py-2 font-medium">Installs</th><th className="py-2 font-medium">Rating</th>
          </tr></thead>
          <tbody>
            {data.assets.map((a) => (
              <tr key={a.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-elevated" onClick={() => navigate(`/app/marketplace/${a.id}`)}>
                <td className="py-2">{a.name}</td>
                <td className="py-2"><Badge tone={a.status === "published" ? "success" : "muted"}>{a.status}</Badge></td>
                <td className="py-2">{a.downloadCount}</td>
                <td className="py-2">{a.avgRating != null ? `★ ${a.avgRating} (${a.ratingCount})` : "No ratings"}</td>
              </tr>
            ))}
            {data.assets.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">Nothing published yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2"><MessageSquare size={18} className="text-accent" /><h3 className="font-display font-semibold">Recent reviews</h3></div>
        <div className="mt-3 space-y-3">
          {data.recentReviews.map((r) => (
            <div key={r.id} className="border-b border-line pb-3 last:border-0">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{r.reviewerName}</span>
                <span className="text-muted">on {r.assetName}</span>
              </div>
              <div className="mt-1 flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={12} className={n <= r.rating ? "fill-amber-400 text-amber-400" : "text-muted"} />)}
              </div>
              {r.reviewText && <p className="mt-1 text-sm text-muted">{r.reviewText}</p>}
              {!r.developerReply && (
                <button className="mt-1 text-xs text-accent hover:underline" onClick={() => navigate(`/app/marketplace/${r.assetId}`)}>Reply</button>
              )}
            </div>
          ))}
          {data.recentReviews.length === 0 && <p className="text-sm text-muted">No reviews yet.</p>}
        </div>
      </Card>
    </div>
  );
}
