"use client";

// Shared multi-select resource picker for the cage-block dialogs, grouped by
// type (Cages / Bullpens / Weight room) — mirrors the work-schedule "Occupies
// cage resources" control. Extracted from schedule-create-dialog.tsx so the
// CREATE dialog and the block EDIT dialog (series edit) share ONE source; the
// create behavior must stay byte-identical.

import type { ResourceOption } from "@/app/admin/sessions/_components/sessions-client";

export const BLOCK_RESOURCE_TYPE_LABELS: Record<
  ResourceOption["type"],
  string
> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight room",
};
export const BLOCK_RESOURCE_TYPE_ORDER: ResourceOption["type"][] = [
  "cage",
  "bullpen",
  "weight_room",
];

export function CagePicker({
  resources,
  selected,
  onToggle,
}: {
  resources: ResourceOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const selectedSet = new Set(selected);
  const groups = BLOCK_RESOURCE_TYPE_ORDER.map((type) => ({
    type,
    items: resources.filter((r) => r.type === type),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        Resources{selected.length > 1 ? ` · ${selected.length} selected` : ""}
      </span>
      <div className="space-y-2.5 rounded-md border border-line bg-page/50 p-3">
        {groups.map((g) => (
          <div key={g.type}>
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle block mb-1">
              {BLOCK_RESOURCE_TYPE_LABELS[g.type]}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((r) => {
                const on = selectedSet.has(r.id);
                return (
                  <label
                    key={r.id}
                    className={[
                      "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-gold/40",
                      on
                        ? "bg-gold/10 border-gold/40 text-gold-strong"
                        : "border-line text-fg-muted hover:text-fg hover:border-line-strong",
                    ].join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => onToggle(r.id)}
                      className="sr-only"
                    />
                    {r.name}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
