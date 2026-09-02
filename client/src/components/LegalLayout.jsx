import { Link } from "react-router-dom";
import { LogoMark } from "./Logo.jsx";

// Shared chrome for public, no-login legal/compliance pages (Privacy.jsx,
// DataDeletion.jsx) — same header mark and footer link pattern as
// Landing.jsx's own public header/footer, deliberately WITHOUT the
// marketing page's aurora/hero styling: these are reference documents a
// Meta reviewer (or a user, or a lawyer) needs to read plainly, not sell
// the product. Both pages that use this are registered at the top level
// in App.jsx (outside the /app ProtectedRoute), so they render with no
// auth check — reachable directly by URL, logged in or not.
export default function LegalLayout({ title, lastUpdated, children }) {
  return (
    <div className="min-h-full">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <LogoMark size={36} />
          <span className="font-display text-[15px] font-semibold">Autopilon</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted">
          <Link to="/privacy" className="hover:text-ink">Privacy Policy</Link>
          <Link to="/data-deletion" className="hover:text-ink">Data Deletion</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
        {lastUpdated && <p className="mt-2 text-sm text-muted">Last updated: {lastUpdated}</p>}
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      <footer className="border-t border-line py-8 text-center text-sm text-muted">
        <Link to="/" className="hover:text-ink">Autopilon</Link> ·{" "}
        <Link to="/privacy" className="hover:text-ink">Privacy Policy</Link> ·{" "}
        <Link to="/data-deletion" className="hover:text-ink">Data Deletion</Link>
      </footer>
    </div>
  );
}

// Small, shared building blocks for the legal pages' body text — plain,
// readable typography using this app's own tokens (font-display for
// headings, text-muted for secondary text, border-line for rules) rather
// than pulling in a markdown/prose plugin for two static documents.
export function Section({ heading, children }) {
  return (
    <section>
      {heading && <h2 className="font-display text-xl font-semibold">{heading}</h2>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function P({ children }) {
  return <p className="text-sm leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-ink [&_a]:text-accent [&_a]:hover:underline">{children}</p>;
}

export function UL({ children }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-ink [&_a]:text-accent [&_a]:hover:underline">{children}</ul>;
}

export function OL({ children }) {
  return <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-ink [&_a]:text-accent [&_a]:hover:underline">{children}</ol>;
}
