"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import {
  AthleteEditDialog,
  type AthleteEditInitialValues,
} from "./athlete-edit-dialog";
import { AssignSidebar } from "./assign-sidebar";
import { archiveAthletesAction, deleteAthleteAction } from "../form-actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { ListSearch } from "@/app/_components/list-search";
import { nameFields, nameMatchesQuery } from "@/app/_components/list-search.logic";
import {
  sortAthletes,
  type SortDir,
  type SortKey,
} from "./roster-sort.logic";

export type ProgramOption = {
  id: string;
  name: string;
};

export type AthleteRow = {
  id: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
  term: string | null;
  programs: ProgramOption[];
};

// Top-level client island for the roster. Owns selection state (for the
// bulk assign/move sidebar), the edit-dialog open state, the
// delete-confirm state, and the delete error message. Renders a vanilla
// <table> — mirrors admin/hour-log/_components/hours-client.tsx and the
// coaches-table pattern.
export function RosterClient({
  athletes,
  programs,
}: {
  athletes: AthleteRow[];
  programs: ProgramOption[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editRow, setEditRow] = useState<AthleteRow | null>(null);
  const [confirmRow, setConfirmRow] = useState<AthleteRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDeleting, startTransition] = useTransition();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isArchiving, startArchiveTransition] = useTransition();
  const [query, setQuery] = useState("");
  // null = no header clicked yet → keep the incoming order.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  // Client-side name filter over the already-loaded rows. Composes with
  // the server-side term filter (?term=): the term narrows what the
  // server hands us; the search narrows that result set here.
  const filtered = useMemo(
    () =>
      athletes.filter((a) =>
        nameMatchesQuery(query, nameFields(a.firstName, a.lastName)),
      ),
    [athletes, query],
  );

  // Apply the column sort AFTER the name search: search narrows, sort
  // orders. With no active sort we display the incoming order untouched.
  const sorted = useMemo(
    () => (sort ? sortAthletes(filtered, sort.key, sort.dir) : filtered),
    [filtered, sort],
  );

  // Click a sortable header: activate it (asc), or toggle asc⇄desc if it
  // is already the active column.
  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev && prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  // Drop any selected ids that no longer exist after a revalidation
  // (e.g. an athlete was deleted). Keeps the bulk bar honest.
  const selectedIds = useMemo(() => {
    const present = new Set(athletes.map((a) => a.id));
    return [...selected].filter((id) => present.has(id));
  }, [selected, athletes]);

  const allSelected =
    athletes.length > 0 && selectedIds.length === athletes.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(athletes.map((a) => a.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setDeleteError(null);
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        const result = await deleteAthleteAction(row.id);
        if (result.ok) {
          setConfirmRow(null);
        } else {
          setDeleteError(
            result.error.code === "ATHLETE_HAS_RECORDS"
              ? "Can't delete — athlete has attendance records."
              : result.error.message,
          );
        }
      } finally {
        setPendingDeleteId(null);
      }
    });
  };

  const handleConfirmArchive = () => {
    if (selectedIds.length === 0) return;
    setArchiveError(null);
    startArchiveTransition(async () => {
      const result = await archiveAthletesAction(selectedIds);
      if (result.ok) {
        setArchiveOpen(false);
        clearSelection();
      } else {
        setArchiveError(result.error.message);
      }
    });
  };

  const editInitial: AthleteEditInitialValues | undefined = editRow
    ? {
        id: editRow.id,
        firstName: editRow.firstName,
        lastName: editRow.lastName,
        birthday: editRow.birthday,
        term: editRow.term,
      }
    : undefined;

  if (athletes.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
        <Users
          className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-fg">No athletes yet</p>
        <p className="mt-1.5 text-sm text-fg-muted">
          Add an athlete above to start building the roster.
        </p>
      </div>
    );
  }

  return (
    <>
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-4 py-2.5">
          <p className="text-sm text-fg">
            {selectedIds.length} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="h-8 rounded-md px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                setArchiveError(null);
                setArchiveOpen(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-sm font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="h-8 rounded-md bg-gold px-3 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              Assign / move…
            </button>
          </div>
        </div>
      ) : null}

      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder="Search players by name…"
        label="Search players by name"
        resultCount={filtered.length}
        totalCount={athletes.length}
      />

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <Users
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">
            No players match &ldquo;{query.trim()}&rdquo;.
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Try a different name, or clear the search to see all players.
          </p>
        </div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all athletes"
                  className="h-4 w-4 accent-gold"
                />
              </th>
              <SortableTh
                label="First"
                sortKey="firstName"
                sort={sort}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Last"
                sortKey="lastName"
                sort={sort}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Birthday"
                sortKey="birthday"
                sort={sort}
                onToggle={toggleSort}
              />
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Term
              </th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Programs
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-right font-semibold sr-only"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const isPendingDelete = pendingDeleteId === row.id;
              const isSelected = selectedIds.includes(row.id);
              return (
                <tr
                  key={row.id}
                  className={`border-t border-line transition last:border-b-0 hover:bg-surface-2 ${
                    isPendingDelete ? "opacity-50" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(row.id)}
                      aria-label={`Select ${row.firstName} ${row.lastName}`}
                      className="h-4 w-4 accent-gold"
                    />
                  </td>
                  <td className="px-4 py-3 text-fg">{row.firstName}</td>
                  <td className="px-4 py-3 text-fg">{row.lastName}</td>
                  <td className="tnum px-4 py-3 font-mono text-xs text-fg-muted whitespace-nowrap">
                    {row.birthday ? formatBirthday(row.birthday) : "—"}
                  </td>
                  <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                    {row.term ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {row.programs.length === 0 ? (
                      <span className="text-fg-subtle">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {row.programs.map((p) => (
                          <span
                            key={p.id}
                            className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-line"
                          >
                            {p.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditRow(row)}
                        disabled={isPendingDelete}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 sm:h-8 sm:w-8"
                        aria-label={`Edit ${row.firstName} ${row.lastName}`}
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteError(null);
                          setConfirmRow(row);
                        }}
                        disabled={isPendingDelete}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 sm:h-8 sm:w-8"
                        aria-label={`Delete ${row.firstName} ${row.lastName}`}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <AthleteEditDialog
        open={editRow !== null}
        onClose={() => setEditRow(null)}
        initial={editInitial}
      />

      <AssignSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onAssigned={clearSelection}
        athleteIds={selectedIds}
        programs={programs}
      />

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next && !isDeleting) {
            setConfirmRow(null);
            setDeleteError(null);
          }
        }}
        title="Delete this athlete?"
        description={
          confirmRow ? (
            <>
              {confirmRow.firstName} {confirmRow.lastName}. This can&apos;t be
              undone.
              {deleteError ? (
                <span className="mt-2 block font-medium text-danger">
                  {deleteError}
                </span>
              ) : null}
            </>
          ) : undefined
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete athlete"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(next) => {
          if (!next && !isArchiving) {
            setArchiveOpen(false);
            setArchiveError(null);
          }
        }}
        variant="default"
        title={`Archive ${selectedIds.length} athlete${
          selectedIds.length === 1 ? "" : "s"
        }?`}
        description={
          <>
            They move to the Archive tab and drop off the active roster. You
            can restore them anytime.
            {archiveError ? (
              <span className="mt-2 block font-medium text-danger">
                {archiveError}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isArchiving ? "Archiving…" : "Archive"}
        onConfirm={handleConfirmArchive}
        isPending={isArchiving}
      />
    </>
  );
}

// A sortable column header: a keyboard-accessible <button> inside the
// <th> that toggles the sort, with an arrow showing the active direction
// and aria-sort on the active column for screen readers.
function SortableTh({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir } | null;
  onToggle: (key: SortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      scope="col"
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
      className="px-4 py-3 text-left font-semibold"
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold uppercase tracking-wider transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
      >
        {label}
        {dir === "asc" ? (
          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
        ) : dir === "desc" ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronsUpDown
            className="h-3.5 w-3.5 text-fg-subtle"
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  );
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

// "May 24, 2010" from a "YYYY-MM-DD" calendar string. Birthday is a pure
// calendar date with no timezone, so we format the parts directly — no
// Date/timezone conversion that could shift the displayed day.
function formatBirthday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
