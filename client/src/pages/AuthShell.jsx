import { Link } from "react-router-dom";
import { LogoLockup } from "../components/Logo.jsx";

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative hidden aurora lg:block">
        <div className="flex h-full flex-col justify-between p-10">
          <Link to="/">
            <LogoLockup height={28} />
          </Link>
          <div>
            <p className="font-display text-2xl font-semibold leading-snug">
              Build agents with skills, memory, and knowledge — in one workspace.
            </p>
            <p className="mt-3 text-sm text-muted">A clean foundation, ready to grow.</p>
          </div>
          <span className="text-xs text-muted">Phase 1 foundation</span>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex justify-center">
            <Link to="/">
              <LogoLockup height={32} />
            </Link>
          </div>
          <h1 className="font-display text-2xl font-semibold">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
          <div className="mt-6 text-sm text-muted">{footer}</div>
        </div>
      </div>
    </div>
  );
}
