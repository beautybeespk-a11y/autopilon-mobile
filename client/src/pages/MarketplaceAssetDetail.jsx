import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Bot, Zap, MessageSquare, BookOpen, Store, Tag, Download, Star, ThumbsUp } from "lucide-react";
import { Card, Button, Badge, Input } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";

const TYPE_ICON = { agent: Bot, automation: Zap, prompt: MessageSquare, knowledge_pack: BookOpen };
const TYPE_LABEL = { agent: "Agent", automation: "Automation", prompt: "Prompt", knowledge_pack: "Knowledge Pack" };
const ENTITY_PAGE = { agent: "/app/agents", automation: "/app/automations", knowledge_item: "/app/knowledge" };

export default function MarketplaceAssetDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [asset, setAsset] = useState(null);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [reviewForm, setReviewForm] = useState({ rating: 5, reviewText: "" });
  const [replyDrafts, setReplyDrafts] = useState({});

  const loadReviews = () => api.get(`/marketplace/assets/${id}/reviews`).then(setReviews).catch(() => {});

  useEffect(() => {
    api.get(`/marketplace/assets/${id}`).then(setAsset).catch((e) => setError(e.message));
    loadReviews();
  }, [id]);

  const submitReview = async () => {
    try {
      await api.post(`/marketplace/assets/${id}/reviews`, reviewForm);
      setReviewForm({ rating: 5, reviewText: "" });
      loadReviews();
      api.get(`/marketplace/assets/${id}`).then(setAsset).catch(() => {});
    } catch (e) {
      alert(e.message);
    }
  };
  const voteHelpful = async (reviewId) => { await api.post(`/marketplace/reviews/${reviewId}/helpful`, {}); loadReviews(); };
  const sendReply = async (reviewId) => {
    const reply = replyDrafts[reviewId];
    if (!reply?.trim()) return;
    await api.post(`/marketplace/reviews/${reviewId}/reply`, { reply });
    setReplyDrafts({ ...replyDrafts, [reviewId]: "" });
    loadReviews();
  };

  const [owned, setOwned] = useState(true);
  useEffect(() => {
    if (asset && asset.pricingType !== "free" && asset.creatorUserId !== user?.id) {
      api.get("/marketplace/my-purchases").then((purchases) => setOwned(purchases.some((p) => p.assetId === asset.id))).catch(() => setOwned(false));
    }
  }, [asset]);

  const install = async () => {
    setInstalling(true);
    try {
      const result = await api.post(`/marketplace/assets/${id}/install`, {});
      setInstallResult(result);
      api.get(`/marketplace/assets/${id}`).then(setAsset).catch(() => {});
    } catch (e) {
      alert(e.message);
    } finally {
      setInstalling(false);
    }
  };

  const buy = async () => {
    try {
      const { url } = await api.post(`/marketplace/assets/${id}/purchase`, {});
      window.location.href = url;
    } catch (e) {
      alert(e.message);
    }
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (!asset) return null;

  const Icon = TYPE_ICON[asset.assetType] || Store;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-14 w-14 place-items-center rounded-xl bg-accent/10 text-accent"><Icon size={26} /></div>
          <div>
            <h1 className="font-display text-2xl font-semibold">{asset.name}</h1>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone="accent">{TYPE_LABEL[asset.assetType]}</Badge>
              <Badge tone={asset.status === "published" ? "success" : "muted"}>{asset.status}</Badge>
              {asset.creatorUserId === user?.id && asset.moderationStatus !== "approved" && (
                <Badge tone={asset.moderationStatus === "pending" ? "warn" : "muted"}>{asset.moderationStatus}</Badge>
              )}
              <span className="text-sm text-muted">v{asset.latestVersion?.version}</span>
            </div>
          </div>
        </div>
      </div>

      <Card className="p-5">
        <p className="text-sm">{asset.description || "No description provided."}</p>
        {asset.tags?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {asset.tags.map((t) => <Badge key={t} tone="muted"><Tag size={10} className="mr-1 inline" />{t}</Badge>)}
          </div>
        )}
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div><span className="text-muted">Price</span><div className="font-medium">{asset.pricingType === "free" ? "Free" : `$${(asset.priceCents / 100).toFixed(2)}`}</div></div>
          <div><span className="text-muted">Installs</span><div className="font-medium">{asset.downloadCount}</div></div>
          <div><span className="text-muted">Rating</span><div className="font-medium">{asset.ratingCount > 0 ? `★ ${(asset.ratingSum / asset.ratingCount).toFixed(1)} (${asset.ratingCount})` : "No ratings yet"}</div></div>
        </div>
        {asset.license && <p className="mt-3 text-xs text-muted">License: {asset.license}</p>}
        {asset.pricingType !== "free" && asset.creatorUserId !== user?.id && !owned ? (
          <Button className="mt-4 w-full" onClick={buy}>
            Buy for ${(asset.priceCents / 100).toFixed(2)}
          </Button>
        ) : (
          <Button className="mt-4 w-full" onClick={install} disabled={installing}>
            <Download size={16} /> {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </Card>

      {installResult && (
        <Card className="border-accent2/30 bg-accent2/5 p-5">
          <h3 className="font-display font-semibold">Installed!</h3>
          <p className="mt-1 text-sm text-muted">
            {installResult.entityType === "knowledge_item"
              ? `Added ${installResult.entityIds.length} item(s) to your Knowledge Library.`
              : `Created a new ${installResult.entityType} in your account, as a draft — review it before activating.`}
          </p>
          {installResult.dependencyNote && <p className="mt-2 text-sm text-amber-500">{installResult.dependencyNote}</p>}
          {ENTITY_PAGE[installResult.entityType] && (
            <Button className="mt-3" variant="outline" onClick={() => navigate(ENTITY_PAGE[installResult.entityType])}>View it</Button>
          )}
        </Card>
      )}

      <Card className="p-5">
        <h3 className="font-display font-semibold">What's included</h3>
        {asset.assetType === "agent" && (
          <div className="mt-2 space-y-1 text-sm">
            <p><span className="text-muted">Personality:</span> {asset.latestVersion?.manifest.personality}</p>
            <p><span className="text-muted">Instructions:</span> {asset.latestVersion?.manifest.instructions}</p>
            <p><span className="text-muted">Requires skills:</span> {asset.latestVersion?.manifest.requiredSkills?.join(", ") || "None"}</p>
          </div>
        )}
        {asset.assetType === "automation" && (
          <div className="mt-2 text-sm">
            <p><span className="text-muted">Trigger:</span> {asset.latestVersion?.manifest.triggerType}</p>
            <p className="mt-1 text-muted">{asset.latestVersion?.manifest.steps?.length || 0} steps</p>
          </div>
        )}
        {asset.assetType === "knowledge_pack" && (
          <p className="mt-2 text-sm text-muted">{asset.latestVersion?.manifest.items?.length || 0} knowledge items</p>
        )}
        {asset.assetType === "prompt" && (
          <p className="mt-2 whitespace-pre-wrap text-sm">{asset.latestVersion?.manifest.promptText}</p>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="font-display font-semibold">Reviews {asset.ratingCount > 0 && `(${asset.ratingCount})`}</h3>

        {asset.creatorUserId !== user?.id && (
          <div className="mt-3 border-b border-line pb-4">
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setReviewForm({ ...reviewForm, rating: n })}>
                  <Star size={20} className={n <= reviewForm.rating ? "fill-amber-400 text-amber-400" : "text-muted"} />
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-end gap-2">
              <div className="flex-1"><Input placeholder="Share your experience (optional)" value={reviewForm.reviewText} onChange={(e) => setReviewForm({ ...reviewForm, reviewText: e.target.value })} /></div>
              <Button onClick={submitReview}>Post review</Button>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="border-b border-line pb-4 last:border-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.userName}</span>
                  {r.verifiedInstall && <Badge tone="success">Verified install</Badge>}
                </div>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={14} className={n <= r.rating ? "fill-amber-400 text-amber-400" : "text-muted"} />)}
                </div>
              </div>
              {r.reviewText && <p className="mt-1 text-sm">{r.reviewText}</p>}
              <div className="mt-2 flex items-center gap-3">
                <button onClick={() => voteHelpful(r.id)} className="flex items-center gap-1 text-xs text-muted hover:text-ink">
                  <ThumbsUp size={12} /> Helpful ({r.helpfulCount})
                </button>
                <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>

              {r.developerReply && (
                <div className="mt-2 rounded-lg bg-elevated p-3 text-sm">
                  <span className="font-medium text-accent">Creator reply: </span>{r.developerReply}
                </div>
              )}
              {asset.creatorUserId === user?.id && !r.developerReply && (
                <div className="mt-2 flex items-end gap-2">
                  <div className="flex-1"><Input placeholder="Reply as the creator…" value={replyDrafts[r.id] || ""} onChange={(e) => setReplyDrafts({ ...replyDrafts, [r.id]: e.target.value })} /></div>
                  <Button variant="outline" onClick={() => sendReply(r.id)}>Reply</Button>
                </div>
              )}
            </div>
          ))}
          {reviews.length === 0 && <p className="text-sm text-muted">No reviews yet.</p>}
        </div>
      </Card>

      <Button variant="outline" onClick={() => navigate("/app/marketplace")}>Back to Marketplace</Button>
      {asset.creatorUserId === user?.id && asset.moderationNote && (
        <p className="text-sm text-amber-500">Moderator note: {asset.moderationNote}</p>
      )}
      {asset.creatorUserId !== user?.id && (
        <button
          className="text-xs text-muted hover:text-red-500"
          onClick={async () => {
            const reason = prompt("Why are you reporting this asset?");
            if (!reason) return;
            await api.post(`/marketplace/assets/${id}/report`, { reason });
            alert("Thanks — this has been reported to the moderation team.");
          }}
        >
          Report this asset
        </button>
      )}
    </div>
  );
}
