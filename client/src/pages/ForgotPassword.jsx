import { useState } from "react";
import { Link } from "react-router-dom";
import AuthShell from "./AuthShell.jsx";
import { Input, Button } from "../components/ui/index.jsx";
import { api } from "../lib/api.js";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post("/auth/forgot-password", { email }); } catch { /* ignore */ }
    setSent(true);
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll send reset instructions to your email."
      footer={<Link to="/login" className="font-medium text-accent hover:underline">Back to log in</Link>}
    >
      {sent ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
          If an account exists for <span className="font-medium text-ink">{email}</span>, reset instructions are on their way.
          <span className="mt-2 block text-xs">Email delivery is wired for a later phase.</span>
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          <Button type="submit" className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}
