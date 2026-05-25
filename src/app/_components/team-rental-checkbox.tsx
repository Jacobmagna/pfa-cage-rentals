// Single checkbox + label for the "team rental" flag, used in every
// session create/edit form. Marks the session as a paying group/team
// booking rather than a coach's private lesson — display surfaces
// (sessions table, schedule grid, reports) render a small badge next
// to the coach name when this is set.
//
// Plain uncontrolled <input type="checkbox" name="isTeamRental">.
// Form-actions read `formData.get("isTeamRental") === "on"`.

export function TeamRentalCheckbox({
  defaultChecked = false,
  className,
}: {
  defaultChecked?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`flex items-center gap-2 cursor-pointer text-sm text-fg select-none ${
        className ?? ""
      }`}
    >
      <input
        type="checkbox"
        name="isTeamRental"
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-line bg-page text-gold focus-visible:ring-2 focus-visible:ring-gold/40 accent-gold"
      />
      <span className="text-fg">Team rental</span>
      <span className="text-xs text-fg-subtle">
        — group / team booking, not a private lesson
      </span>
    </label>
  );
}
