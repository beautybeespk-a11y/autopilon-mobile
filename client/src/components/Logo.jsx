// The mark (A-in-a-ring) reads fine on both light and dark surfaces as-is —
// its cyan fill is the same accent2 teal/cyan family the rest of the app
// already uses unchanged across both themes — so a single file covers both.
// The full lockup's baked-in wordmark text does need to swap for contrast,
// so LogoLockup renders both supplied variants and lets Tailwind's `dark:`
// class toggle (see tailwind.config.js `darkMode: "class"`) pick one.
export function LogoMark({ size = 36, className = "" }) {
  return (
    <img
      src="/autopilon-mark.svg"
      alt="Autopilon"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
    />
  );
}

export function LogoLockup({ height = 32, className = "" }) {
  return (
    <span className={`inline-flex ${className}`} style={{ height }}>
      <img src="/autopilon-logo.svg" alt="Autopilon — AI that runs your business" style={{ height }} className="hidden w-auto dark:block" />
      <img src="/autopilon-logo-light.svg" alt="Autopilon — AI that runs your business" style={{ height }} className="block w-auto dark:hidden" />
    </span>
  );
}
