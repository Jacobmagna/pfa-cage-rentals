import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import {
  getTravelMasterPlayerList,
  type TravelMasterPlayerRow,
} from "@/travel/roster-report";

// Block 5b — the operator MASTER PLAYER LIST (/travel/admin/players). Guarded
// operator-only (requireTravelAccess redirects a guardian / no session). A
// READ-ONLY roster-oversight surface: one row per travel athlete (operator-wide,
// NO guardian filter) with their team(s), families, and a dues rollup. A GET
// search form scopes the list by ?q= (athlete / guardian / email / team).
// NO write actions, NO forms that POST, NO Stripe.
//
// Skin: matches 5a finances — flat rounded-md, hairline border on bg-surface,
// credential uppercase micro-labels, amounts in Geist Mono (font-mono tnum
// tabular-nums) right-aligned. Facility tokens only (text-success/danger/gold).

type SearchParams = Promise<{ q?: string }>;

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

const TH =
  "px-4 py-2.5 text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

const MONEY = "font-mono tnum tabular-nums whitespace-nowrap";

// Format integer cents → "$1,234.00".
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Search bar: a small GET form (mirrors the 5a PeriodBar). A single text input
// resubmits to this route; a "Clear" reset link shows only when a query is set.
function SearchBar({ q }: { q: string }) {
  const input =
    "h-10 w-full rounded-md border border-line bg-page px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";
  return (
    <form
      method="GET"
      action="/travel/admin/players"
      className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface p-4"
    >
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
        <span className={LABEL}>Search</span>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Player, guardian, email, or team…"
          className={input}
        />
      </label>
      <button
        type="submit"
        className="inline-flex h-10 items-center rounded-md bg-yellow px-5 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
      >
        Search
      </button>
      {q ? (
        <Link
          href="/travel/admin/players"
          className="inline-flex h-10 items-center text-sm text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
        >
          Clear
        </Link>
      ) : null}
    </form>
  );
}

// Player sub-line: gradYear / ageGroup / positions, joined with a middot; blanks
// dropped so a sparse athlete doesn't render stray separators.
function playerMeta(row: TravelMasterPlayerRow): string {
  const bits: string[] = [];
  if (row.gradYear != null) bits.push(`Class of ${row.gradYear}`);
  if (row.ageGroup) bits.push(row.ageGroup);
  if (row.positions) bits.push(row.positions);
  return bits.join(" · ");
}

function TeamsCell({ teams }: { teams: TravelMasterPlayerRow["teams"] }) {
  if (teams.length === 0) {
    return <span className="text-[11px] text-fg-subtle">No team</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {teams.map((t) => (
        <span
          key={t.teamId}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted"
        >
          <span className="font-medium text-fg">{t.teamName}</span>
          {t.cohort ? (
            <span className="text-fg-subtle">{t.cohort}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function FamilyCell({
  guardians,
}: {
  guardians: TravelMasterPlayerRow["guardians"];
}) {
  if (guardians.length === 0) {
    return <span className="text-[11px] text-fg-subtle">No guardian</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {guardians.map((g) => (
        <div key={g.guardianId} className="leading-tight">
          <p className="text-fg">{g.guardianName || "—"}</p>
          <p className="text-[11px] text-fg-subtle">{g.email}</p>
        </div>
      ))}
    </div>
  );
}

// Dues cell: billed (muted) over outstanding (gold when > 0), plus a small status
// hint from the distinct invoice statuses. No invoices → an em dash.
function DuesCell({ row }: { row: TravelMasterPlayerRow }) {
  if (row.invoiceStatuses.length === 0) {
    return <span className="text-[11px] text-fg-subtle">—</span>;
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`${MONEY} text-fg-muted`}>
        {formatUsd(row.billedCents)} billed
      </span>
      <span
        className={`${MONEY} font-semibold ${
          row.outstandingCents > 0 ? "text-gold" : "text-success"
        }`}
      >
        {formatUsd(row.outstandingCents)} due
      </span>
      <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {row.invoiceStatuses.join(" · ")}
      </span>
    </div>
  );
}

export default async function TravelPlayersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const rows = await getTravelMasterPlayerList({ search: query });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">
            Master Player List
          </h1>
          <p className="text-[11px] uppercase tracking-wider text-fg-subtle">
            {rows.length} player{rows.length === 1 ? "" : "s"}
            {query ? (
              <>
                {" "}
                matching{" "}
                <span className="font-mono normal-case tracking-normal text-fg-muted">
                  “{query}”
                </span>
              </>
            ) : null}
          </p>
        </div>
        <p className="text-xs text-fg-muted">
          Operator roster oversight — every travel athlete with their team(s),
          family, and dues rollup. Read-only.
        </p>
      </div>

      <SearchBar q={query} />

      <section className="overflow-hidden rounded-md border border-line bg-surface">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-fg-muted">
              {query
                ? `No players match “${query}”.`
                : "No travel players yet."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className={TH}>Player</th>
                  <th className={TH}>Team(s)</th>
                  <th className={TH}>Family</th>
                  <th className={`${TH} text-right`}>Dues</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const meta = playerMeta(row);
                  return (
                    <tr
                      key={row.athleteId}
                      className="border-b border-line last:border-0 align-top"
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-fg">
                          {row.athleteName || "—"}
                        </p>
                        {meta ? (
                          <p className="text-[11px] text-fg-subtle">{meta}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <TeamsCell teams={row.teams} />
                      </td>
                      <td className="px-4 py-3">
                        <FamilyCell guardians={row.guardians} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DuesCell row={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
