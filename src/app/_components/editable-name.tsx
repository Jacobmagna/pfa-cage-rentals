"use client";

import { useRef, useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { updateOwnName } from "../actions";

// Renders the user's name inline with a pencil affordance. Click pencil →
// swap to a focused <input> with Save / Cancel. Persists via updateOwnName
// in src/app/actions.ts; the server action revalidates /admin /coach
// /admin/coaches so every surface that displays the name re-renders.
//
// Why a client component on a server-rendered page: edit-in-place needs
// local UI state for the toggle + input value. The parent page stays
// a server component (auth + DB reads); only this small island ships JS.

export function EditableName({ initialName }: { initialName: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialName);
  const [committed, setCommitted] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const open = () => {
    setValue(committed);
    setError(null);
    setEditing(true);
    // Defer focus to next tick so the input is mounted.
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const cancel = () => {
    setEditing(false);
    setValue(committed);
    setError(null);
  };

  const save = () => {
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("Name cannot be empty");
      return;
    }
    if (trimmed === committed) {
      setEditing(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const { name } = await updateOwnName({ name: trimmed });
        setCommitted(name);
        setValue(name);
        setEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save name");
      }
    });
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span>{committed}</span>
        <button
          type="button"
          onClick={open}
          aria-label="Edit your name"
          className="rounded-md p-1 text-fg-subtle hover:text-gold hover:bg-surface transition-colors"
        >
          <Pencil className="h-4 w-4" />
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1 align-bottom">
      <span className="inline-flex items-center gap-2">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          maxLength={80}
          disabled={isPending}
          className="rounded-md border border-line bg-page text-fg px-2 py-1 text-xl font-bold tracking-tight focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          style={{ width: `${Math.max(value.length, 8) + 2}ch` }}
        />
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="rounded-md border border-gold/40 bg-gold/15 px-2.5 py-1 text-xs font-medium text-gold hover:border-gold disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={isPending}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-muted hover:text-fg hover:border-line-strong disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
      {error ? (
        <span className="text-xs text-red-400" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
