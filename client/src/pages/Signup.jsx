import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "./AuthShell.jsx";
import { Input, Button } from "../components/ui/index.jsx";
import { useAuth } from "../lib/auth.jsx";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try { await signup(form.name, form.email, form.password); navigate("/app"); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell
      title="Create your workspace"
      subtitle="A few details and you're in."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-accent hover:underline">Log in</Link></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={set("name")} placeholder="Your name" required />
        <Input label="Email" type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" required />
        <Input label="Password" type="password" value={form.password} onChange={set("password")} placeholder="At least 6 characters" required />
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Creating…" : "Create account"}</Button>
      </form>
    </AuthShell>
  );
}
