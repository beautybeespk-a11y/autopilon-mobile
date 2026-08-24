import { Link } from "react-router-dom";
import { Sparkles, ArrowRight, Bot, Wrench, Zap, Plug, FolderKanban, Users } from "lucide-react";
import { Button, Card } from "../components/ui/index.jsx";

const FEATURES = [
  { icon: Bot, title: "AI agents", body: "Give an agent a job, instructions, and a personality — then talk to it like a teammate." },
  { icon: Wrench, title: "Skills", body: "Agents pick up abilities as you need them — web research, document analysis, and more." },
  { icon: Plug, title: "Integrations", body: "Connect the tools you already use — Gmail, WhatsApp, WooCommerce, Shopify, Google Workspace, and more." },
  { icon: Zap, title: "Automations", body: "Let an agent act on its own when something happens, instead of asking it every time." },
];

const HOW_IT_WORKS = [
  { step: "1", title: "Create an agent", body: "Start from a template or build one from scratch — give it a job and instructions." },
  { step: "2", title: "Connect what it needs", body: "Link an integration if the agent's job requires one — your inbox, store, or messaging." },
  { step: "3", title: "Put it to work", body: "Chat with it directly, or let an automation trigger it when something happens." },
];

const WHO_ITS_FOR = [
  "Small businesses that want AI help without hiring a developer",
  "Marketers who want an assistant that can actually publish and manage campaigns",
  "Store owners who want order/inventory questions answered instantly",
  "Anyone who wants one place to build and run AI agents, not a dozen disconnected tools",
];

const FAQ = [
  { q: "Is this a chatbot, or something more?", a: "More. A chatbot only talks. An Autopilon agent can also use real tools — searching the web, reading files, managing your store, sending messages — based on instructions you give it once." },
  { q: "Do I need to know how to code?", a: "No. Creating an agent is filling out a form: what should it do, what should it be able to access. Integrations are a one-time connect." },
  { q: "Can I sign up right now?", a: "We're in a closed beta — sign-ups are by invitation while we work directly with a small group of early users. Request access below and we'll reach out." },
  { q: "What happens to my data?", a: "Your integrations, conversations, and files stay isolated to your own account — other users, even ones using a shared agent, never get access to your connected tools or data." },
];

export default function Landing() {
  return (
    <div className="min-h-full">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl accent-gradient text-white shadow-glow">
            <Sparkles size={18} />
          </div>
          <span className="font-display text-[15px] font-semibold">Autopilon</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" to="/login">Log in</Button>
          <Button to="/signup">Request Beta Access</Button>
        </div>
      </header>

      {/* Hero */}
      <section className="aurora">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center md:py-32">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full accent-gradient" /> Currently in private beta
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-tight md:text-6xl">
            AI agents that actually do the work — not just talk about it.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted md:text-lg">
            Build an assistant with real instructions, real tools, and real access to the apps you already
            use — then let it handle the parts of your day you'd rather hand off.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button to="/signup" className="px-5 py-3">Request Beta Access <ArrowRight size={16} /></Button>
            <Button variant="outline" to="/login" className="px-5 py-3">I have an account</Button>
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <h2 className="text-center font-display text-2xl font-semibold md:text-3xl">What you can build</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
                <Icon size={20} />
              </div>
              <h3 className="font-display font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-line bg-surface/50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center font-display text-2xl font-semibold md:text-3xl">How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {HOW_IT_WORKS.map(({ step, title, body }) => (
              <div key={step} className="text-center">
                <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full accent-gradient font-display font-semibold text-white shadow-glow">
                  {step}
                </div>
                <h3 className="font-display font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Productivity — projects/tasks */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid items-center gap-8 md:grid-cols-2">
          <div>
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
              <FolderKanban size={20} />
            </div>
            <h2 className="font-display text-2xl font-semibold">More than chat — real workspace</h2>
            <p className="mt-3 text-muted">
              Projects, tasks, and a knowledge base sit alongside your agents, so the work they help with
              stays organized in one place instead of scattered across chat history.
            </p>
          </div>
          <Card className="aurora p-6">
            <p className="text-sm text-muted">
              Everything an agent does — messages sent, orders looked up, content drafted — is recorded and
              attributable, so you always know what happened and why.
            </p>
          </Card>
        </div>
      </section>

      {/* Who it's for */}
      <section className="border-y border-line bg-surface/50 py-20">
        <div className="mx-auto max-w-3xl px-6">
          <div className="mb-3 flex justify-center">
            <Users size={24} className="text-accent" />
          </div>
          <h2 className="text-center font-display text-2xl font-semibold md:text-3xl">Who it's for</h2>
          <ul className="mt-8 space-y-3">
            {WHO_ITS_FOR.map((line) => (
              <li key={line} className="flex items-start gap-3 text-sm">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full accent-gradient" />
                <span className="text-ink">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Beta CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="font-display text-2xl font-semibold md:text-3xl">Join the private beta</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted">
          We're working closely with a small group of early users. Request access and we'll follow up.
        </p>
        <Button to="/signup" className="mt-6 px-5 py-3">Request Beta Access <ArrowRight size={16} /></Button>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <h2 className="text-center font-display text-2xl font-semibold md:text-3xl">Questions</h2>
        <div className="mt-8 space-y-4">
          {FAQ.map(({ q, a }) => (
            <Card key={q} className="p-5">
              <h3 className="font-display font-semibold">{q}</h3>
              <p className="mt-1.5 text-sm text-muted">{a}</p>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-sm text-muted">
        <Link to="/signup" className="hover:text-ink">Request Beta Access</Link> · Private beta
      </footer>
    </div>
  );
}
