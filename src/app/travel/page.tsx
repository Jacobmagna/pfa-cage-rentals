// Travel landing (server component). Placeholder hero for the travel host
// while the slice is dark; the real homepage design is a later scoped task.
// Renders inside src/app/travel/layout.tsx, which supplies the shell chrome.

export default function TravelHome() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-xl">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          PFA Travel
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
          PFA Travel
        </h1>
        <p className="mt-4 text-base leading-relaxed text-fg-muted">
          Travel baseball registration, teams, and team store — coming soon.
        </p>
      </div>
    </section>
  );
}
