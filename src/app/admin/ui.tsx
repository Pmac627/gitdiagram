"use client";

// Building blocks the dashboard's panels share.

/** Small buttons grow to a finger-sized target on touch screens. */
export const TOUCH = "pointer-coarse:h-11";

export function Panel({
  title,
  aside,
  className = "",
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`neo-panel min-w-0 rounded-lg p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold tracking-wide uppercase">{title}</h2>
        {aside ? (
          <div className="text-xs text-[hsl(var(--neo-soft-text))]">
            {aside}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border-2 border-black bg-white/70 p-3 dark:bg-black/20">
      <div className="text-xs font-semibold text-[hsl(var(--neo-soft-text))]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-1 text-xs text-[hsl(var(--neo-soft-text))]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}
