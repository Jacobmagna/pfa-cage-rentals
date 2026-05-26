"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  previewOrCommitImport,
  type ImportFormState,
} from "../actions";
import type {
  Decision,
  DecisionAction,
  GroupSummary,
} from "@/lib/import/commit";

type CoachOption = { id: string; name: string | null; email: string };

const INITIAL: ImportFormState = { stage: "idle" };

export function ImportForm({ coaches }: { coaches: CoachOption[] }) {
  const [state, formAction, isPending] = useActionState(previewOrCommitImport, INITIAL);
  // Admin overrides only — unset rows fall back to suggestedAction at render + submit time.
  const [overrides, setOverrides] = useState<Record<string, Decision>>({});

  function updateOverride(rawName: string, patch: Partial<Decision>, suggestedAction: DecisionAction) {
    setOverrides((prev) => ({
      ...prev,
      [rawName]: {
        ...{ rawName, action: suggestedAction },
        ...prev[rawName],
        ...patch,
      },
    }));
  }

  const groups = state.stage === "preview" ? state.preview.groups : [];
  // Build the complete decision array from suggestedAction defaults + admin overrides.
  // Always send one decision per group so the server doesn't need an implicit fallback.
  const decisionsJSON = JSON.stringify(
    groups.map((g) => {
      const override = overrides[g.rawName];
      if (override) return override;
      const d: Decision = { rawName: g.rawName, action: g.suggestedAction };
      if (g.suggestedAction === "map" && g.existingUserMatch) {
        d.mappedUserId = g.existingUserMatch.id;
      }
      return d;
    }),
  );

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="decisions" value={decisionsJSON} />

      <FileInputRow disabled={isPending} />

      {state.stage === "error" && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {state.message}
        </div>
      )}

      {state.stage === "preview" && (
        <PreviewSection
          fileName={state.fileName}
          groups={state.preview.groups}
          totalParsed={state.preview.totalParsed}
          coaches={coaches}
          overrides={overrides}
          updateOverride={updateOverride}
          isPending={isPending}
        />
      )}

      {state.stage === "committed" && <CommitSummary result={state.result} />}
    </form>
  );
}

function FileInputRow({ disabled }: { disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="xlsx" className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Excel file
        </label>
        <input
          id="xlsx"
          name="xlsx"
          type="file"
          accept=".xlsx"
          required
          className="text-sm text-fg file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-fg hover:file:border-line-strong"
        />
      </div>
      <button
        type="submit"
        name="intent"
        value="preview"
        disabled={disabled}
        className="rounded-md border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-line-strong disabled:opacity-50"
      >
        {disabled ? "Working…" : "Preview"}
      </button>
    </div>
  );
}

function PreviewSection({
  fileName,
  groups,
  totalParsed,
  coaches,
  overrides,
  updateOverride,
  isPending,
}: {
  fileName: string;
  groups: GroupSummary[];
  totalParsed: number;
  coaches: CoachOption[];
  overrides: Record<string, Decision>;
  updateOverride: (rawName: string, patch: Partial<Decision>, suggestedAction: DecisionAction) => void;
  isPending: boolean;
}) {
  const effective = (g: GroupSummary): DecisionAction =>
    overrides[g.rawName]?.action ?? g.suggestedAction;

  const counts = { skip: 0, sessionsImporting: 0, sessionsSkipping: 0 };
  for (const g of groups) {
    const a = effective(g);
    if (a === "skip") {
      counts.skip += 1;
      counts.sessionsSkipping += g.count;
    } else {
      counts.sessionsImporting += g.count;
    }
  }

  return (
    <>
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Preview</p>
        <p className="mt-1 text-sm text-fg">
          <span className="text-gold">{fileName}</span> — {totalParsed} session
          {totalParsed === 1 ? "" : "s"} parsed across {groups.length} distinct
          raw name{groups.length === 1 ? "" : "s"}.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-fg-muted sm:grid-cols-4">
          <Stat label="Will import" value={counts.sessionsImporting} accent="gold" />
          <Stat label="Will skip" value={counts.sessionsSkipping} />
          <Stat label="Coach groups" value={groups.length} />
          <Stat label="Of which to skip" value={counts.skip} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-2 text-left text-[10px] uppercase tracking-[0.18em] text-fg-muted">
            <tr>
              <th className="px-3 py-2">Raw name</th>
              <th className="px-3 py-2">Canonical</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2 text-right">Sessions</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Map to</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const action = effective(g);
              return (
                <tr key={g.rawName} className="border-t border-line/60">
                  <td className="px-3 py-2 font-mono text-xs text-fg">{g.rawName}</td>
                  <td className="px-3 py-2 text-fg">
                    {g.canonicalName || <span className="text-fg-subtle">—</span>}
                    {g.existingUserMatch && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-gold">
                        existing
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <ConfidenceBadge confidence={g.confidence} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{g.count}</td>
                  <td className="px-3 py-2">
                    <select
                      value={action}
                      onChange={(e) =>
                        updateOverride(
                          g.rawName,
                          { action: e.target.value as DecisionAction },
                          g.suggestedAction,
                        )
                      }
                      className="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-fg"
                    >
                      <option value="create">Create new coach</option>
                      <option value="map">Map to existing</option>
                      <option value="skip">Skip</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    {action === "map" ? (
                      <select
                        value={
                          overrides[g.rawName]?.mappedUserId ??
                          g.existingUserMatch?.id ??
                          ""
                        }
                        onChange={(e) =>
                          updateOverride(
                            g.rawName,
                            { mappedUserId: e.target.value },
                            g.suggestedAction,
                          )
                        }
                        className="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-fg"
                      >
                        <option value="">— choose coach —</option>
                        {coaches.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name ?? c.email}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          name="intent"
          value="commit"
          disabled={isPending}
          className="rounded-md border border-gold/40 bg-gold/15 px-4 py-2 text-sm font-medium text-gold hover:border-gold disabled:opacity-50"
        >
          {isPending ? "Committing…" : `Commit import (${counts.sessionsImporting} sessions)`}
        </button>
        <p className="text-xs text-fg-muted">
          Re-select the file above if needed — it must be the same workbook for the
          decisions to apply.
        </p>
      </div>
    </>
  );
}

function CommitSummary({ result }: { result: NonNullable<Extract<ImportFormState, { stage: "committed" }>["result"]> }) {
  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Import complete</p>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
          <Stat label="Sessions created" value={result.created} accent="gold" />
          <Stat label="Already imported" value={result.skippedDuplicates} />
          <Stat label="Skipped (overlap)" value={result.skippedOverlaps} />
          <Stat label="Skipped (by plan)" value={result.skippedByPlan.reduce((s, r) => s + r.count, 0)} />
          <Stat label="Errored" value={result.errored.length} />
        </div>
        <p className="mt-2 text-xs text-fg-muted">
          New coach users created: {result.newCoachesCreated}
        </p>
      </div>
      {result.errored.length > 0 && (
        <details className="rounded border border-danger/40 bg-danger/5 p-3 text-xs">
          <summary className="cursor-pointer text-danger">
            Errored rows ({result.errored.length})
          </summary>
          <ul className="mt-2 space-y-1 text-danger/90">
            {result.errored.map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.sessionDescription}</span> — {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Link
        href="/admin/schedule"
        className="inline-block rounded-md border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong"
      >
        View schedule →
      </Link>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "gold" }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.18em] text-fg-muted">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${accent === "gold" ? "text-gold" : "text-fg"}`}>
        {value}
      </p>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: GroupSummary["confidence"] }) {
  const map = {
    alias: { label: "alias", className: "border-success/40 text-success bg-success/5" },
    fuzzy: { label: "fuzzy", className: "border-warning/40 text-warning bg-warning/5" },
    cleaned: { label: "cleaned", className: "border-gold/40 text-gold bg-gold/5" },
    unmatched: { label: "unmatched", className: "border-danger/40 text-danger bg-danger/5" },
  } as const;
  const m = map[confidence];
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${m.className}`}
    >
      {m.label}
    </span>
  );
}
