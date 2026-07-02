"use client";

// QA-3: shared, per-occurrence skip report for the cage-block create dialog
// (BlockReport) and the recurring-series edit dialog (SeriesReport). Both
// render THIS component so the two reports are byte-identical. REPORT-ONLY —
// it reformats the already-returned action result; it makes no decisions.

import { useState } from "react";
import type {
  SkippedBlock,
  SkippedRental,
} from "@/lib/server/block-series-actions";

type SkipReportInput = {
  created: number;
  skippedRentals: SkippedRental[];
  skippedBlocked: SkippedBlock[];
};

// One plain-text line per skipped row for the "Copy list" clipboard export.
function blockLine(b: SkippedBlock): string {
  return `${b.date} · ${b.startTime} – ${b.endTime} · ${b.resourceName} · ${b.blockedByLabel}`;
}

function rentalLine(r: SkippedRental): string {
  // r.label is already "date · time – time · cage · coach" (built server-side).
  return r.label;
}

function buildCopyText(result: SkipReportInput): string {
  const total =
    result.created + result.skippedBlocked.length + result.skippedRentals.length;
  const lines: string[] = [
    `Blocked ${result.created} new cage days out of ${total} total. Skipped:`,
  ];
  if (result.skippedBlocked.length > 0) {
    lines.push("");
    lines.push(`Already blocked out (${result.skippedBlocked.length}):`);
    for (const b of result.skippedBlocked) lines.push(blockLine(b));
  }
  if (result.skippedRentals.length > 0) {
    lines.push("");
    lines.push(`Conflicting rentals (${result.skippedRentals.length}):`);
    for (const r of result.skippedRentals) lines.push(rentalLine(r));
  }
  return lines.join("\n");
}

export function BlockSkipReport({ result }: { result: SkipReportInput }) {
  const [copied, setCopied] = useState(false);
  const skipCount =
    result.skippedBlocked.length + result.skippedRentals.length;
  const hasSkips = skipCount > 0;
  const total = result.created + skipCount;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildCopyText(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions/insecure context) — no-op; the on-screen
      // list is still readable.
    }
  };

  return (
    <div
      className={[
        "rounded-md border px-3 py-2.5 text-xs space-y-2",
        result.created === 0
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-line-strong bg-surface-2 text-fg",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">
          {hasSkips
            ? `Blocked ${result.created} new cage days out of ${total} total. Skipped:`
            : `Blocked ${result.created} new cage days.`}
        </p>
        {hasSkips ? (
          <button
            type="button"
            onClick={onCopy}
            className="shrink-0 rounded-md border border-line bg-page px-2 py-1 text-[11px] font-medium text-fg-muted hover:text-fg hover:border-line-strong transition-colors"
          >
            {copied ? "Copied" : "Copy list"}
          </button>
        ) : null}
      </div>

      {result.skippedBlocked.length > 0 ? (
        <div className="space-y-1">
          <p className="text-fg-muted">
            Already blocked out ({result.skippedBlocked.length}):
          </p>
          <ul className="max-h-40 overflow-y-auto rounded border border-line bg-page/50 divide-y divide-line/60">
            {result.skippedBlocked.map((b, i) => (
              <li
                key={`${b.date}-${b.resourceName}-${i}`}
                className="px-2 py-1 text-fg-muted truncate"
              >
                {b.date} · {b.startTime} – {b.endTime} · {b.resourceName} ·{" "}
                {b.blockedByLabel}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.skippedRentals.length > 0 ? (
        <div className="space-y-1">
          <p className="text-fg-muted">
            Conflicting rentals ({result.skippedRentals.length}):
          </p>
          <ul className="max-h-40 overflow-y-auto rounded border border-line bg-page/50 divide-y divide-line/60">
            {result.skippedRentals.map((r, i) => (
              <li
                key={`${r.date}-${r.resourceName}-${i}`}
                className="px-2 py-1 text-fg-muted truncate"
              >
                {r.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
