"use client";

// Admin Home quick actions (UI-only wiring). A row of 4 gold buttons that
// sit ABOVE the Master Schedule and are ALWAYS visible. They reuse the two
// existing reusable dialogs exactly as editable-master-schedule.tsx does:
//   - ScheduleCreateDialog (cage rental / block cages, via defaultTab)
//   - ProgramBlockDialog   (new work log)
// "Coaches" is a plain link to /admin/coaches.
//
// prefill/createPrefill are null so the dialogs open BLANK — the admin picks
// resource/date/time, matching the existing "+ New rental" button.

import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ScheduleCreateDialog } from "@/app/admin/schedule/_components/schedule-create-dialog";
import type {
  CoachOption as CageCoachOption,
  ResourceOption as CageResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import {
  ProgramBlockDialog,
  type CoachOption as ProgramCoachOption,
  type ProgramOption,
  type ResourceOption as ProgramResourceOption,
} from "@/app/admin/hour-log/schedule/_components/program-block-dialog";

export function HomeQuickActions({
  cageCoaches,
  cageResources,
  programs,
  programCoaches,
  programResources,
  selectedDate,
}: {
  cageCoaches: CageCoachOption[];
  cageResources: CageResourceOption[];
  programs: ProgramOption[];
  programCoaches: ProgramCoachOption[];
  programResources: ProgramResourceOption[];
  selectedDate: Date;
}) {
  const [cageOpen, setCageOpen] = useState(false);
  const [cageTab, setCageTab] = useState<"session" | "block">("session");
  const [programOpen, setProgramOpen] = useState(false);

  return (
    <>
      <div className="mb-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setCageTab("session");
            setCageOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New cage rental
        </button>
        <button
          type="button"
          onClick={() => setProgramOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New work log
        </button>
        <button
          type="button"
          onClick={() => {
            setCageTab("block");
            setCageOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Block cages
        </button>
        <Link
          href="/admin/coaches"
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Coaches
        </Link>
      </div>

      <ScheduleCreateDialog
        open={cageOpen}
        onClose={() => setCageOpen(false)}
        coaches={cageCoaches}
        resources={cageResources}
        prefill={null}
        defaultTab={cageTab}
      />
      <ProgramBlockDialog
        open={programOpen}
        mode="create"
        onClose={() => setProgramOpen(false)}
        date={selectedDate}
        programs={programs}
        coaches={programCoaches}
        resources={programResources}
        createPrefill={null}
        editInitial={null}
        editSeriesInitial={null}
      />
    </>
  );
}
