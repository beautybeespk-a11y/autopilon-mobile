import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { NAV, MOBILE_PRIMARY } from "./nav-items.js";
import { LogoMark } from "./Logo.jsx";

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const primary = NAV.filter((n) => MOBILE_PRIMARY.includes(n.to));

  return (
    <>
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 md:hidden">
        <Link to="/app" className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="font-display text-sm font-semibold">Autopilon</span>
        </Link>
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-muted hover:bg-elevated" aria-label="Open menu">
          <Menu size={20} />
        </button>
      </div>

      {/* Slide-out drawer for secondary sections */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-72 border-l border-line bg-surface p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-display font-semibold">Menu</span>
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-muted hover:bg-elevated" aria-label="Close menu">
                <X size={20} />
              </button>
            </div>
            <nav className="space-y-1">
              {NAV.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${
                      isActive ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"
                    }`
                  }
                >
                  <Icon size={18} /> {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* Bottom bar for primary sections */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-line bg-surface/95 backdrop-blur md:hidden">
        {primary.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${isActive ? "text-accent" : "text-muted"}`
            }
          >
            <Icon size={20} /> {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
