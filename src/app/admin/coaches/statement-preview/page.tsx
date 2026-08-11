// ⚠️ DEV-ONLY VISUAL MOCK — DELETE BEFORE THE REAL BUILD LANDS.
//
// A look-and-feel review of the payment-statement design (SPEC §5) before any
// backend work exists. It renders the real `StatementCard` against a fixture,
// inside the real admin AppShell, at a path under /admin/coaches so the top nav
// lights the SAME tab the finished feature will live under — Billing & Records.
//
// Deliberate properties:
//   - Reads NO database and touches no coach data. The fixture is invented.
//   - `notFound()` unless NODE_ENV is development, so it cannot exist in a
//     production build even by accident (the same shape the dark travel route
//     used). That is also why it can skip requireRole("admin") and still be
//     safe — there is nothing here to protect, and needing a session cookie
//     would defeat the point of a quick visual review.
//   - Static segment `statement-preview` wins over the sibling `[id]` dynamic
//     route, so it never shadows a real coach page.
//
// The month chips are live (they move the active state and relabel the period)
// but the FIGURES do not change — one fixture, three labels. The banner says so.

import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { StatementCard } from "../[id]/_components/statement-card";
import { FIXTURE_STATEMENT } from "@/lib/statement/fixture";
import type { StatementAccount, StatementPair } from "@/lib/statement/types";

const PERIODS = {
  jun: { chip: "Jun", label: "Jun 1 – Jun 30, 2026", endShort: "Jun 30", prevShort: "May 31" },
  jul: { chip: "Jul", label: "Jul 1 – Jul 31, 2026", endShort: "Jul 31", prevShort: "Jun 30" },
  aug: { chip: "Aug", label: "Aug 1 – Aug 31, 2026", endShort: "Aug 31", prevShort: "Jul 31" },
} as const;

type PeriodKey = keyof typeof PERIODS;

function isPeriod(v: string | undefined): v is PeriodKey {
  return v === "jun" || v === "jul" || v === "aug";
}

/** Re-labels the fixture for the selected month. Figures are unchanged. */
function relabel(pair: StatementPair, period: PeriodKey): StatementPair {
  const p = PERIODS[period];
  const patch = (s: StatementPair["cage"]) => ({
    ...s,
    openingLabel: `Previous balance (as of ${p.prevShort})`,
    closingLabel: `Statement balance as of ${p.endShort}`,
  });
  return {
    ...pair,
    periodLabel: p.label,
    periodEndShort: p.endShort,
    cage: patch(pair.cage),
    work: patch(pair.work),
  };
}

export default async function StatementPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; period?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const params = await searchParams;
  const account: StatementAccount = params.account === "work" ? "work" : "cage";
  const period: PeriodKey = isPeriod(params.period) ? params.period : "jul";

  const pair = relabel(FIXTURE_STATEMENT, period);
  const href = (a: StatementAccount, p: PeriodKey = period) =>
    `/admin/coaches/statement-preview?account=${a}&period=${p}`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div
        data-print-hide
        className="mb-6 flex gap-3 rounded-lg border border-blue/30 bg-blue/5 p-3.5 text-xs leading-relaxed"
      >
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-blue" />
        <div>
          <p className="font-semibold">
            Design mock — filler numbers, no database
          </p>
          <p className="mt-1 text-fg-muted">
            Layout review only. On the real thing this renders inside a coach&rsquo;s
            page at <span className="tabular-nums">/admin/coaches/&lt;id&gt;</span>{" "}
            (Billing &amp; Records → Coaches → a coach), below the existing cards, and
            Reports rows get a &ldquo;Statement →&rdquo; link into it. Every figure
            below foots by hand on purpose. The month chips move and relabel the
            period but the figures stay put — one fixture, three labels.
          </p>
        </div>
      </div>

      <StatementCard
        pair={pair}
        account={account}
        hrefForAccount={(a) => href(a)}
        periodChips={[
          ...(Object.keys(PERIODS) as PeriodKey[]).map((key) => ({
            label: PERIODS[key].chip,
            href: href(account, key),
            active: key === period,
          })),
          // SPEC §6: the chips are PRESETS over a from/to, so "Custom" is part
          // of the control, not an afterthought. Inert in the mock — on the
          // real thing it reveals the two DateInputs.
          { label: "Custom ▾", href: href(account), active: false },
        ]}
      />
    </div>
  );
}
