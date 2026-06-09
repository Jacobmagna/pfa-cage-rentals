"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitMerge, UserX } from "lucide-react";
import {
  mergeAthletesAction,
  dismissDuplicateAction,
} from "../actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import type {
  DuplicateGroupView,
  DuplicateGroupMember,
} from "@/lib/server/athlete-actions";

// Client island for the duplicates review page (#17). One card per group;
// each card lets the admin pick which record to KEEP (survivor) and either
// merge the rest into it or mark the whole group as different people. Both
// mutations call the requireRole-gated server actions and router.refresh()
// on success so the resolved group drops out of the (re-fetched) list.
//
// Selection state is keyed by a stable group key (the sorted member ids) so
// it survives re-renders. The merge confirmation reuses the shared
// ConfirmDialog; "Not duplicates" gets its own (non-destructive default)
// confirm. Action errors surface inline per card — never a crash.

export function DuplicatesClient({
  groups,
}: {
  groups: DuplicateGroupView[];
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <DuplicateGroupCard key={groupKey(group)} group={group} />
      ))}
    </div>
  );
}

// Stable key + default-survivor pick share the same id sort, so derive once.
function groupKey(group: DuplicateGroupView): string {
  return group.members
    .map((m) => m.id)
    .sort()
    .join("|");
}

// Pre-pick the member with the most data: a birthday wins first, then the
// higher attendance count, then more programs. Stable tiebreak on id so the
// default is deterministic across renders.
function defaultSurvivorId(members: DuplicateGroupMember[]): string {
  return [...members].sort((a, b) => {
    const aHasBday = a.birthday ? 1 : 0;
    const bHasBday = b.birthday ? 1 : 0;
    if (aHasBday !== bHasBday) return bHasBday - aHasBday;
    if (a.attendanceCount !== b.attendanceCount)
      return b.attendanceCount - a.attendanceCount;
    if (a.programs.length !== b.programs.length)
      return b.programs.length - a.programs.length;
    return a.id.localeCompare(b.id);
  })[0].id;
}

function DuplicateGroupCard({ group }: { group: DuplicateGroupView }) {
  const router = useRouter();
  const [survivorId, setSurvivorId] = useState(() =>
    defaultSurvivorId(group.members),
  );
  const [mergeOpen, setMergeOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMerging, startMerge] = useTransition();
  const [isDismissing, startDismiss] = useTransition();
  const radioName = useMemo(() => `survivor-${groupKey(group)}`, [group]);

  const survivor =
    group.members.find((m) => m.id === survivorId) ?? group.members[0];
  const others = group.members.filter((m) => m.id !== survivor.id);
  const pending = isMerging || isDismissing;

  const handleConfirmMerge = () => {
    setError(null);
    startMerge(async () => {
      try {
        await mergeAthletesAction(
          survivor.id,
          others.map((m) => m.id),
        );
        setMergeOpen(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Merge failed.");
      }
    });
  };

  const handleConfirmDismiss = () => {
    setError(null);
    startDismiss(async () => {
      try {
        // Dismiss every unordered pair in the group so none re-surface.
        // Groups are almost always 2 members → a single pair.
        const pairs = unorderedPairs(group.members.map((m) => m.id));
        await Promise.all(
          pairs.map(([a, b]) => dismissDuplicateAction(a, b)),
        );
        setDismissOpen(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't update.");
      }
    });
  };

  const otherNames = others.map(fullName).join(", ");

  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <MatchBadge matchType={group.matchType} />
        <span className="text-[11px] text-fg-subtle">
          {group.members.length} records
        </span>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Pick the record to keep</legend>
        {group.members.map((member) => {
          const isSurvivor = member.id === survivor.id;
          return (
            <label
              key={member.id}
              className={`flex cursor-pointer flex-col gap-2 rounded-lg border px-4 py-3 transition-colors ${
                isSurvivor
                  ? "border-[color:var(--color-blue)] bg-[color:var(--color-blue)]/5 ring-1 ring-[color:var(--color-blue)]/30"
                  : "border-line bg-page hover:border-line-strong"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="radio"
                  name={radioName}
                  checked={isSurvivor}
                  onChange={() => setSurvivorId(member.id)}
                  disabled={pending}
                  className="mt-0.5 h-4 w-4 accent-[color:var(--color-blue)]"
                  aria-label={`Keep ${fullName(member)}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-fg">
                      {fullName(member)}
                    </span>
                    {isSurvivor ? (
                      <span className="shrink-0 rounded-full bg-[color:var(--color-blue)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-blue-strong)]">
                        Keep
                      </span>
                    ) : null}
                  </div>
                  <p className="tnum mt-0.5 font-mono text-xs text-fg-muted">
                    {member.birthday
                      ? formatBirthday(member.birthday)
                      : "No birthday"}
                  </p>
                </div>
              </div>

              <dl className="ml-[26px] space-y-1.5 text-xs">
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Term</dt>
                  <dd className="text-fg-muted">{member.term ?? "—"}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Programs</dt>
                  <dd className="min-w-0 flex-1">
                    {member.programs.length === 0 ? (
                      <span className="text-fg-subtle">No programs</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {member.programs.map((name) => (
                          <span
                            key={name}
                            className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-fg-muted ring-1 ring-inset ring-line"
                          >
                            {name}
                          </span>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Attendance</dt>
                  <dd className="text-fg-muted">
                    {member.attendanceCount} attended
                  </dd>
                </div>
              </dl>
            </label>
          );
        })}
      </fieldset>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setDismissOpen(true);
          }}
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-sm font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          <UserX className="h-4 w-4" />
          Not duplicates
        </button>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setMergeOpen(true);
          }}
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-gold px-3 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          <GitMerge className="h-4 w-4" />
          Merge into selected
        </button>
      </div>

      <ConfirmDialog
        open={mergeOpen}
        onOpenChange={(next) => {
          if (!next && !isMerging) {
            setMergeOpen(false);
            setError(null);
          }
        }}
        title="Merge these records?"
        description={
          <>
            Keep <span className="font-medium text-fg">{fullName(survivor)}</span>
            , merge in{" "}
            <span className="font-medium text-fg">{otherNames}</span>. Their
            attendance and programs move onto{" "}
            <span className="font-medium text-fg">{fullName(survivor)}</span> and
            the duplicate{others.length === 1 ? " record is" : " records are"}{" "}
            deleted. This cannot be undone.
            {error ? (
              <span className="mt-2 block font-medium text-danger">
                {error}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isMerging ? "Merging…" : "Merge records"}
        onConfirm={handleConfirmMerge}
        isPending={isMerging}
      />

      <ConfirmDialog
        open={dismissOpen}
        onOpenChange={(next) => {
          if (!next && !isDismissing) {
            setDismissOpen(false);
            setError(null);
          }
        }}
        variant="default"
        title="Mark these as different people?"
        description={
          <>
            They won&apos;t be flagged as duplicates again.
            {error ? (
              <span className="mt-2 block font-medium text-danger">
                {error}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isDismissing ? "Saving…" : "Not duplicates"}
        onConfirm={handleConfirmDismiss}
        isPending={isDismissing}
      />
    </div>
  );
}

function MatchBadge({ matchType }: { matchType: "exact" | "possible" }) {
  if (matchType === "exact") {
    return (
      <span className="inline-flex items-center rounded-full bg-danger/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-danger ring-1 ring-inset ring-danger/30">
        Exact match
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted ring-1 ring-inset ring-line">
      Possible match
    </span>
  );
}

function fullName(member: DuplicateGroupMember): string {
  return `${member.firstName} ${member.lastName}`;
}

// All unordered pairs {a,b} from a list of ids. For a 2-member group that's
// the single pair; for 3+ it's every combination so no pair re-surfaces.
function unorderedPairs(ids: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  return pairs;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "May 24, 2010" from a "YYYY-MM-DD" calendar string — same pure-parts
// formatter the roster uses, so no timezone shift on the displayed day.
function formatBirthday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
