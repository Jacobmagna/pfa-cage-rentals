// ⚠️ DEV-ONLY VISUAL MOCK — DELETE BEFORE THE REAL BUILD LANDS.
//
// A look-and-feel review of the payment-statement design (SPEC §5, §8) before
// any backend work exists. It reproduces /admin/reports using the REAL filter
// bar and the REAL sub-tab strip, with a fixture behind them — so what is being
// reviewed is the actual surface Mark will use, not an artist's impression.
//
// Deliberate properties:
//   - Reads NO database. The fixture is invented.
//   - `notFound()` unless NODE_ENV is development, so it cannot exist in a
//     production build even by accident.
//   - Lives under /admin/reports/ so the top nav lights the SAME tab the
//     finished feature will (Billing & Records).
//
// The month chips relabel the period but the FIGURES do not change — one
// fixture, three labels. The banner says so.

import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { FiltersForm } from "../_components/filters-form";
import { ReportsTabs } from "../_components/reports-tabs";
import { StatementRoster } from "../_components/statement-roster";
import { StatementCard } from "@/app/admin/coaches/[id]/_components/statement-card";
import { FIXTURE_ROSTER, FIXTURE_STATEMENT } from "@/lib/statement/fixture";
import { normalizeReportTab } from "@/lib/reports/tabs";
import type { StatementAccount, StatementPair } from "@/lib/statement/types";

const BASE = "/admin/reports/statement-preview";

const PERIODS = {
  jun: { chip: "Jun", from: "2026-06-01", to: "2026-06-30", label: "Jun 1 – Jun 30, 2026", endShort: "Jun 30", prevShort: "May 31" },
  jul: { chip: "Jul", from: "2026-07-01", to: "2026-07-31", label: "Jul 1 – Jul 31, 2026", endShort: "Jul 31", prevShort: "Jun 30" },
  aug: { chip: "Aug", from: "2026-08-01", to: "2026-08-31", label: "Aug 1 – Aug 31, 2026", endShort: "Aug 31", prevShort: "Jul 31" },
} as const;

type PeriodKey = keyof typeof PERIODS;

function isPeriod(v: string | undefined): v is PeriodKey {
  return v === "jun" || v === "jul" || v === "aug";
}

const COACHES = FIXTURE_ROSTER.map((r) => ({
  id: r.coachId,
  name: r.coachName,
  email: `${r.coachId}@example.com`,
}));

const PROGRAMS = [
  { id: "throwing", name: "HS Summer Program-Throwing" },
  { id: "summer", name: "HS Summer Program" },
];

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
  searchParams: Promise<{
    tab?: string;
    account?: string;
    period?: string;
    coachIds?: string | string[];
  }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const params = await searchParams;
  const tab = normalizeReportTab(params.tab ?? "statements");
  const period: PeriodKey = isPeriod(params.period) ? params.period : "jul";
  const account: StatementAccount = params.account === "work" ? "work" : "cage";
  const coachIds = (
    Array.isArray(params.coachIds)
      ? params.coachIds
      : params.coachIds
        ? [params.coachIds]
        : []
  ).filter(Boolean);

  const p = PERIODS[period];
  const qs = `from=${p.from}&to=${p.to}&period=${period}${coachIds
    .map((id) => `&coachIds=${id}`)
    .join("")}`;

  // ONE coach in scope → their statement. Otherwise the roll-up (SPEC §8).
  const single = coachIds.length === 1 ? coachIds[0] : null;
  const pair = relabel(FIXTURE_STATEMENT, period);

  return (
    <div className="mx-auto max-w-6xl">
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
            This is <span className="font-medium">/admin/reports</span> with a
            fourth sub-tab. The filter bar and tab strip are the real
            components. <span className="font-medium">See statement for this
            period</span> below the filters jumps straight here carrying whatever
            is set above. Pick a single coach to see one statement; leave it on
            all coaches for the roll-up. Every figure foots by hand on purpose;
            the month chips relabel the period but the figures stay put.
          </p>
        </div>
      </div>

      <div data-print-hide>
        <FiltersForm
          coaches={COACHES}
          programs={PROGRAMS}
          values={{
            from: p.from,
            to: p.to,
            coachIds,
            resourceTypes: [],
            programId: "",
          }}
          activeTab={tab}
        />

        <ReportsTabs
          activeTab={tab}
          filterQueryString={qs}
          basePath={BASE}
        />

        {/* Mock-only shortcuts: the real filter bar posts to /admin/reports, so
            these stand in for narrowing the coach MultiSelect and the month. */}
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed border-line-strong p-3 text-xs">
          <span className="font-semibold uppercase tracking-wider text-fg-muted">
            Mock controls
          </span>
          <span className="text-fg-subtle">Period:</span>
          {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
            <a
              key={key}
              href={`${BASE}?tab=${tab}&period=${key}&account=${account}${coachIds.map((id) => `&coachIds=${id}`).join("")}`}
              className={
                key === period
                  ? "font-semibold text-fg underline"
                  : "text-fg-muted hover:text-fg"
              }
            >
              {PERIODS[key].chip}
            </a>
          ))}
          <span className="ml-2 text-fg-subtle">Coach:</span>
          <a
            href={`${BASE}?tab=${tab}&period=${period}`}
            className={
              single === null
                ? "font-semibold text-fg underline"
                : "text-fg-muted hover:text-fg"
            }
          >
            All
          </a>
          <a
            href={`${BASE}?tab=${tab}&period=${period}&coachIds=alex&account=${account}`}
            className={
              single === "alex"
                ? "font-semibold text-fg underline"
                : "text-fg-muted hover:text-fg"
            }
          >
            Alex Milone only
          </a>
        </div>
      </div>

      {tab === "statements" ? (
        single ? (
          <StatementCard
            pair={pair}
            account={account}
            hrefForAccount={(a) =>
              `${BASE}?tab=statements&period=${period}&coachIds=${single}&account=${a}`
            }
          />
        ) : (
          <StatementRoster
            rows={FIXTURE_ROSTER}
            periodLabel={p.label}
            hrefForCoach={(coachId) =>
              `${BASE}?tab=statements&period=${period}&coachIds=${coachId}&account=cage`
            }
          />
        )
      ) : (
        <div
          data-print-hide
          className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-fg-subtle"
        >
          The <span className="font-medium">{tab}</span> tab is the existing
          shipped view — not reproduced in this mock. Switch to{" "}
          <span className="font-medium">Statements</span>.
        </div>
      )}
    </div>
  );
}
