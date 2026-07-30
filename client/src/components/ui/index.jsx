import { Link } from "react-router-dom";

export function Card({ className = "", children, as: As = "div", ...rest }) {
  return (
    <As className={`rounded-2xl border border-line bg-surface shadow-soft ${className}`} {...rest}>
      {children}
    </As>
  );
}

const VARIANTS = {
  primary: "accent-gradient text-white shadow-glow hover:opacity-95",
  ghost: "text-ink hover:bg-elevated",
  outline: "border border-line text-ink hover:bg-elevated",
  subtle: "bg-elevated text-ink hover:brightness-105",
};

export function Button({ variant = "primary", className = "", to, children, ...rest }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none";
  const cls = `${base} ${VARIANTS[variant]} ${className}`;
  if (to) return <Link to={to} className={cls} {...rest}>{children}</Link>;
  return <button className={cls} {...rest}>{children}</button>;
}

export function Input({ label, className = "", ...rest }) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>}
      <input
        className={`w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 ${className}`}
        {...rest}
      />
    </label>
  );
}

export function Textarea({ label, className = "", ...rest }) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>}
      <textarea
        className={`w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 ${className}`}
        {...rest}
      />
    </label>
  );
}

export function Badge({ children, tone = "muted" }) {
  const tones = {
    muted: "bg-elevated text-muted",
    accent: "bg-accent/10 text-accent",
    success: "bg-accent2/15 text-accent2",
    warn: "bg-amber-400/15 text-amber-500",
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-16 text-center">
      {Icon && (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Icon size={26} />
        </div>
      )}
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
