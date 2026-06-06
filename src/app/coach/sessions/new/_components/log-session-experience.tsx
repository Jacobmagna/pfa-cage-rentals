"use client";

// View switcher for the coach "Log a session" page. The Calendly-style
// cage CALENDAR is the default surface; a small "Prefer the form?" toggle
// swaps to the existing <LogSessionForm>, which is kept fully working
// (nothing lost). The calendar is wider than the form, so each view
// manages its own max-width wrapper.

import { useState } from "react";
import { CalendarDays, ListChecks } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { LogSessionForm } from "./log-session-form";
import { CageCalendar } from "./cage-calendar";

type View = "calendar" | "form";

export function LogSessionExperience({
  resources,
  coachId,
  coachName,
}: {
  resources: ResourceOption[];
  coachId: string;
  coachName: string;
}) {
  const [view, setView] = useState<View>("calendar");

  return (
    <div className="space-y-5">
      {/* Segmented control. */}
      <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
        <ToggleButton
          active={view === "calendar"}
          onClick={() => setView("calendar")}
          icon={<CalendarDays className="h-4 w-4" />}
          label="Calendar"
        />
        <ToggleButton
          active={view === "form"}
          onClick={() => setView("form")}
          icon={<ListChecks className="h-4 w-4" />}
          label="Prefer the form?"
        />
      </div>

      {view === "calendar" ? (
        <CageCalendar
          resources={resources}
          coachId={coachId}
          coachName={coachName}
        />
      ) : (
        <div className="max-w-md">
          <LogSessionForm resources={resources} />
        </div>
      )}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "inline-flex items-center gap-1.5 rounded-md px-3 h-9 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        active
          ? "bg-gold/15 text-gold-strong"
          : "text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}
