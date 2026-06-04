// Presentational stat card for the dashboard hero rows. Renders an icon +
// label, a large tabular-figures value, and a sub caption. Pass `accent`
// for the gold-rail emphasis variant. No client hooks — safe to render
// inside a server component (extracted from /admin so the Hour Log and
// Home surfaces can reuse the exact same card). Pure refactor of the old
// inline `Stat` function.
export function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={[
        "relative overflow-hidden rounded-2xl border px-6 py-5 shadow-[var(--shadow-md)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]",
        accent
          ? "border-gold/40 bg-gradient-to-b from-[#fffdf8] to-[#fcf4e2]"
          : "border-line bg-surface",
      ].join(" ")}
    >
      {accent ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-gold to-gold-strong"
        />
      ) : null}
      <div
        className={[
          "flex items-center gap-2",
          accent ? "text-gold-strong" : "text-fg-muted",
        ].join(" ")}
      >
        {icon}
        <p className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
          {label}
        </p>
      </div>
      <p
        className={[
          "tnum mt-4 text-4xl font-semibold tracking-tight",
          accent ? "text-gold-strong" : "text-fg",
        ].join(" ")}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-fg-subtle">{sub}</p>
    </div>
  );
}
