// Checkbox for the PFA-referred flag, mirrors TeamRentalCheckbox.
// Marks a session whose client was arranged by PFA (rather than
// sourced by the coach). Pure record-keeping — doesn't change what
// the coach owes PFA. Form-actions read
// `formData.get("pfaReferred") === "on"`.

export function PfaReferredCheckbox({
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
        name="pfaReferred"
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-line bg-page text-gold focus-visible:ring-2 focus-visible:ring-gold/40 accent-gold"
      />
      <span className="text-fg">PFA-referred</span>
      <span className="text-xs text-fg-subtle">
        — PFA arranged this client
      </span>
    </label>
  );
}
