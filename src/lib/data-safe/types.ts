// The de-identified fact rows that `computeAggregates` returns. The
// snapshot orchestrator (Worker B) stamps anon_client_id / vertical /
// period_start / period_end / source_run_id when it pushes; aggregates
// only ever produce metric / value / subType / dims.
//
// PRIVACY CONTRACT for `dims`: it may ONLY carry bucket labels (e.g.
// resource_type, lead_time_bucket, cancel_category) or a salted-hash
// `anon_coach_id`. It must NEVER contain a name, an email, a raw/athlete
// id, or any per-athlete data. Athletes appear ONLY as facility counts.
export type OpFact = {
  metric: string;
  value: number;
  subType?: string | null;
  dims?: Record<string, string | number> | null;
};
