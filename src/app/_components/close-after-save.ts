"use client";

// Closes a save dialog right after its server action answers "saved", from
// inside the action itself, instead of waiting for useActionState's
// `pending` to go back to false.
//
// Why: on a production build (Next 16.2.6), about 1 save in 6 left the admin
// dialogs on "Saving…" forever although the server had answered 200. React
// parks the update that carries the revalidated page as suspended, with
// nothing to retry it, so `pending` never flips back and the old "close when
// pending goes true → false" effect never fired. Any other state update
// releases it. Calling the dialog's onClose after the await is exactly such
// an update (a state update after an await is not part of the action's
// transition), so the dialog closes as soon as the save has landed.
// Diagnosis: maintenance/qa-0ae/stuck-saving/ (reproduced on main too).
//
// A refused save returns `{ ok: false }` and does not close: the dialog stays
// open with the typed values and the reason, as before. A thrown error does
// not close either.

import { useCallback, useEffect, useRef } from "react";

/**
 * Pure core: an action that awaits `action` and, when its result is `ok`,
 * calls `close()` AFTER the await, then returns the result unchanged.
 */
export function closeAfterOk<S extends { ok: boolean }, A extends unknown[]>(
  action: (...args: A) => Promise<S>,
  close: () => void,
): (...args: A) => Promise<S> {
  return async (...args: A) => {
    const result = await action(...args);
    if (result.ok) close();
    return result;
  };
}

/**
 * The action to hand to useActionState in place of `action`. It closes the
 * dialog through a ref, so the onClose it calls is never stale, and only
 * while this dialog is still mounted and open: the same "open" condition
 * the old pending latch had. An admin who closed the dialog while it was
 * saving, then opened another one (which mounts a new dialog through the
 * per-opening `key`), must not have that new dialog closed by the old save.
 */
export function useCloseAfterOkAction<S extends { ok: boolean }>(
  action: (prev: S, formData: FormData) => Promise<S>,
  onClose: () => void,
  open: boolean,
): (prev: S, formData: FormData) => Promise<S> {
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const mountedRef = useRef(false);

  // Latest-ref sync after every commit (assigning during render is flagged
  // by react-hooks/refs).
  useEffect(() => {
    onCloseRef.current = onClose;
    openRef.current = open;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useCallback(
    (prev: S, formData: FormData) =>
      closeAfterOk(action, () => {
        if (mountedRef.current && openRef.current) onCloseRef.current();
      })(prev, formData),
    [action],
  );
}
