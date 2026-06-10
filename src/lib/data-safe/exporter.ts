// Data-Safe Snapshot — the WRITE-ONLY exporter that appends de-identified
// OpFact rows to Magna's central store (a SEPARATE Neon warehouse, NOT in
// this app's Drizzle schema).
//
// WRITE-ONLY CONTRACT (enforced by the store's role grants AND here):
//   - This module NEVER issues a SELECT. The pfa_writer role has INSERT only
//     and cannot read any row (its own or another client's). We count
//     inserted rows from the INSERT ... RETURNING id payload — which the
//     engine returns for the rows it actually inserts, requiring no SELECT
//     privilege. Conflicting rows (ON CONFLICT DO NOTHING) return nothing,
//     so `inserted` < `attempted` is the dedupe signal.
//   - Idempotent: the store's unique key is
//     (anon_client_id, metric, period_start, period_end, dims_hash). We
//     compute dims_hash via the SHARED `dimsHash` so re-runs of the same
//     period dedupe deterministically.
//   - Parameterized values only — fact values/dims are passed as bind
//     params, never string-interpolated into SQL.
//
// The raw `neon()` tagged-template client is used (not Drizzle) because the
// store table is intentionally absent from our schema.

import { neon } from "@neondatabase/serverless";

import { dimsHash } from "./anonymize";
import type { OpFact } from "./types";

export type PushContext = {
  databaseUrl: string;
  anonClientId: string;
  vertical: string;
  periodStart: Date;
  periodEnd: Date;
  sourceRunId: string;
};

export type PushResult = {
  inserted: number;
  attempted: number;
};

/**
 * Append `facts` to the central store's `op_facts` table, idempotently.
 *
 * Each fact INSERTs one row with its computed `dims_hash`; the unique index
 * (anon_client_id, metric, period_start, period_end, dims_hash) makes
 * re-runs of the same period a no-op via ON CONFLICT DO NOTHING.
 *
 * `inserted` = rows the engine actually wrote (length of the RETURNING id
 * payload); `attempted` = facts.length. No row is ever read back.
 */
export async function pushFacts(
  facts: OpFact[],
  ctx: PushContext,
): Promise<PushResult> {
  if (facts.length === 0) {
    return { inserted: 0, attempted: 0 };
  }

  const sql = neon(ctx.databaseUrl);

  let inserted = 0;
  for (const fact of facts) {
    const dims = fact.dims ?? null;
    const subType = fact.subType ?? null;
    const dimsHashValue = dimsHash(fact.dims);

    // Parameterized: every value is a bind param. ON CONFLICT DO NOTHING +
    // RETURNING id → returns one row iff this tuple was newly inserted, zero
    // rows on conflict. No SELECT is ever issued.
    const rows = (await sql`
      INSERT INTO op_facts (
        anon_client_id,
        vertical,
        sub_type,
        period_start,
        period_end,
        metric,
        value,
        dims,
        dims_hash,
        source_run_id
      ) VALUES (
        ${ctx.anonClientId},
        ${ctx.vertical},
        ${subType},
        ${ctx.periodStart.toISOString()},
        ${ctx.periodEnd.toISOString()},
        ${fact.metric},
        ${fact.value},
        ${dims === null ? null : JSON.stringify(dims)},
        ${dimsHashValue},
        ${ctx.sourceRunId}
      )
      ON CONFLICT (anon_client_id, metric, period_start, period_end, dims_hash)
      DO NOTHING
      RETURNING id
    `) as Array<{ id: number }>;

    inserted += rows.length;
  }

  return { inserted, attempted: facts.length };
}
