import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "./AuthShell.jsx";
import { Input, Button } from "../components/ui/index.jsx";
import { useAuth } from "../lib/auth.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try { await login(email, password); navigate("/app"); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your workspace."
      footer={<>New here? <Link to="/signup" className="font-medium text-accent hover:underline">Create an account</Link></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Logging in…" : "Log in"}</Button>
        <Link to="/forgot-password" className="block text-center text-sm text-muted hover:text-ink">Forgot password?</Link>
      </form>
    </AuthShell>
  );
}
