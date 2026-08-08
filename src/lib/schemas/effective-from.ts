// SPEC rate-effective-dating §3 + decision §10.1 — PAST + PRESENT ONLY.
//
// ONE definition of "a legal effective date", shared by BOTH rate-setting
// inputs (the per-(coach, program) override and the program default) so the
// two can never disagree about what an admin is allowed to pick.
//
// It deliberately mirrors the refinement `rateRepriceInputSchema` applies in
// src/lib/server/rate-reprice.ts. That duplication is the point, not an
// oversight: the engine re-validates whatever the action layer hands it, so a
// future date has to get past two independent checks. It is NOT imported from
// rate-reprice.ts because that module pulls in `@/db`, and these schema
// modules are imported by client form components — importing it would drag a
// database connection into the browser bundle.
//
// Semantics of the three states:
//   - undefined (omitted) → "going forward only". Today's exact behavior:
//     the new rate prices new logs, nothing already logged is touched.
//   - null → the same thing, stated explicitly (and it CLEARS a previously
//     stored effective date on the row, because that date described the
//     PREVIOUS rate and would otherwise start lying).
//   - a Date at or before now → re-price already-logged hours from that
//     date forward (SPEC §6).

import { z } from "zod";

export const EFFECTIVE_FROM_FUTURE_MESSAGE =
  "Effective date cannot be in the future";

export const effectiveFromSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now(), EFFECTIVE_FROM_FUTURE_MESSAGE)
  .nullish();
