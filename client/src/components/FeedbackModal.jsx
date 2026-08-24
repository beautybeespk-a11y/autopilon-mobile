import { useState } from "react";
import { useLocation } from "react-router-dom";
import { X, MessageSquareText, Check } from "lucide-react";
import { Card, Button, Textarea } from "./ui/index.jsx";
import { api } from "../lib/api.js";

const TYPES = [
  { id: "bug", label: "Report a bug" },
  { id: "feature", label: "Request a feature" },
  { id: "general", label: "General feedback" },
];

export default function FeedbackModal({ onClose }) {
  const location = useLocation();
  const [type, setType] = useState("general");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api.post("/feedback", { type, message: message.trim(), page: location.pathname });
      setSent(true);
    } catch (err) {
      setError(err.message || "Couldn't send feedback — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4">
      <Card className="relative w-full max-w-md p-6">
        <button onClick={onClose} className="absolute right-4 top-4 text-muted hover:text-ink" aria-label="Close">
          <X size={18} />
        </button>

        {sent ? (
          <div className="text-center py-4">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent2/15 text-accent2">
              <Check size={24} />
            </div>
            <h2 className="font-display text-lg font-semibold">Thanks for the feedback</h2>
            <p className="mt-1 text-sm text-muted">We read every submission during the beta.</p>
            <Button className="mt-5 w-full" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="mb-1 flex items-center gap-2">
              <MessageSquareText size={18} className="text-accent" />
              <h2 className="font-display text-lg font-semibold">Give feedback</h2>
            </div>
            <p className="mb-4 text-sm text-muted">Tell us what's working, what's broken, or what you wish existed.</p>

            <div className="mb-4 flex gap-2">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setType(t.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    type === t.id ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What's on your mind?"
              rows={5}
              maxLength={5000}
              required
            />
            {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
            <Button type="submit" className="mt-4 w-full" disabled={submitting || !message.trim()}>
              {submitting ? "Sending…" : "Send feedback"}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
