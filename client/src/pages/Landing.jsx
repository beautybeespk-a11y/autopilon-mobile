import { Link } from "react-router-dom";
import { Sparkles, ArrowRight, Bot, Wrench, Zap, BookOpen } from "lucide-react";
import { Button } from "../components/ui/index.jsx";

const FEATURES = [
  { icon: Bot, title: "Custom agents", body: "Compose agents with a personality, instructions, and skills." },
  { icon: Wrench, title: "Modular skills", body: "A registry of capabilities agents discover at runtime." },
  { icon: Zap, title: "Automations", body: "Turn repeatable work into background routines." },
  { icon: BookOpen, title: "Knowledge", body: "Ground answers in your own documents." },
];

export default function Landing() {
  return (
    <div className="min-h-full">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl accent-gradient text-white shadow-glow">
            <Sparkles size={18} />
          </div>
          <span className="font-display text-[15px] font-semibold">AI Agent Platform</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" to="/login">Log in</Button>
          <Button to="/signup">Get started</Button>
        </div>
      </header>

      <section className="aurora">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center md:py-32">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full accent-gradient" /> Build agents that actually do the work
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-tight md:text-6xl">
            One workspace for every AI agent you build.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-muted md:text-lg">
            Give agents skills, tools, memory, and knowledge — then put them to work across the tools you already use.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button to="/signup" className="px-5 py-3">Start building <ArrowRight size={16} /></Button>
            <Button variant="outline" to="/login" className="px-5 py-3">I have an account</Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      <footer className="border-t border-line py-8 text-center text-sm text-muted">
        <Link to="/signup" className="hover:text-ink">Create your workspace</Link> · Phase 1 foundation
      </footer>
    </div>
  );
}
