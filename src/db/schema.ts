import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  integer,
  boolean,
  jsonb,
  date,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

export const roleEnum = pgEnum("role", ["coach", "admin"]);
export const resourceType = pgEnum("resource_type", [
  "cage",
  "bullpen",
  "weight_room",
]);
export const sessionUseType = pgEnum("use_type", ["hitting", "pitching"]);

// Period over which a program's participation cap is measured. Used by
// programs.cap_period. Co-required with programs.cap (both NULL or both
// NOT NULL — enforced by a hand-added CHECK constraint in the migration).
export const capPeriod = pgEnum("cap_period", ["week", "month"]);

// Period over which a PER-ATHLETE enrollment participation cap is
// measured (FEAT-11 redesign). Used by athlete_programs.cap_period.
// "week" = Sun–Sat, "month" = calendar month, "total" = the whole
// program (no reset). Distinct enum from `capPeriod` (the dormant
// program-level cap) because it adds the "total" option.
export const enrollmentCapPeriod = pgEnum("enrollment_cap_period", [
  "week",
  "month",
  "total",
]);

// RECUR-a recurrence frequency for program_schedule_series.frequency.
// "weekly" = the original every-N-weeks model (daysOfWeek expanded each
// week whose index is a multiple of `interval`); "monthly" = same-weekday
// monthly (e.g. "2nd Tuesday each month", weekday + ordinal derived from
// startsOn, stepping by `interval` months). Defaults to "weekly" so every
// pre-existing series row keeps today's behavior unchanged.
export const recurrenceFrequency = pgEnum("recurrence_frequency", [
  "weekly",
  "monthly",
]);

// QA10 W3-polish15: a coach flag on a scheduled program block. "cancelled"
// = the coach proactively says they will NOT run a block they're assigned
// to (optional reason); stays unreviewed until an admin resolves it.
// "no_show" = an admin-side tombstone for an acknowledged no-show
// (stamped reviewed at insert). The coach side only writes "cancelled".
export const blockCoachFlagKind = pgEnum("program_block_coach_flag_kind", [
  "cancelled",
  "no_show",
]);

// `deletedAt`: soft-delete timestamp for the J9 GDPR-style account-
// removal flow. NULL = active. When set, the row is anonymized:
// `name` becomes "Former coach" and `email` becomes
// `deleted-<id>@pfacagerentals.invalid` (`.invalid` TLD by RFC 2606,
// so the address can never collide with a real inbox and frees the
// real email for re-signup). Billing rows still FK to the user id,
// so historical reports remain accurate while the identity link is
// broken. Active-coach surfaces filter `isNull(users.deletedAt)`;
// reports + audit log do not, so historical "Former coach" rows
// keep their billing context.
export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // Contact number, seeded from the coach roster (FEAT-12 pass 2).
  // NULL = unknown. Shown read-only on /admin/coaches/[id].
  phone: text("phone"),
  role: roleEnum("role").notNull().default("coach"),
  // Payment handles. Admin sees Zelle on /admin/coaches/[id] and
  // /admin/payments as a reconciliation hint. Coach-facing surfaces
  // never expose them. NULL = not set.
  //
  // venmoHandle is DORMANT (no UI consumer) — the business Venmo
  // account charges fees on incoming payments so Dad doesn't accept
  // Venmo. Column kept on the off chance Venmo Business changes their
  // pricing, to avoid a destructive migration.
  venmoHandle: text("venmo_handle"),
  zelleContact: text("zelle_contact"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
});

// Org-wide settings singleton. One row with id='default' (seeded in
// the migration). Holds PFA's Zelle contact that admin tracks as
// the canonical "pay PFA here" reference. Separate from any one
// admin's personal handles so Dad can change the receiver without
// touching his user record. The `pfaDisplayName` ("PFA Sports") is
// the label used on admin surfaces that reference the org.
//
// pfaVenmoHandle is DORMANT (no UI consumer) — same Venmo-fees
// reason as users.venmoHandle. Coach-facing /coach/payments surface
// was removed 2026-05-25; values here are admin-only reference data.
export const orgSettings = pgTable("org_settings", {
  id: text("id").primaryKey(),
  pfaVenmoHandle: text("pfa_venmo_handle"),
  pfaZelleContact: text("pfa_zelle_contact"),
  pfaDisplayName: text("pfa_display_name").notNull().default("PFA Sports"),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  updatedBy: text("updated_by").references(() => users.id),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// Default per-30-min rate (in cents) for each resource type.
// Primary key is `type` itself — exactly one default row per
// resource type forever, no "Cage default v2" concept. Per-coach
// overrides live in a separate `coach_rate_overrides` table (C4)
// and take precedence over these defaults.
//
// Cents-only (integer column) to dodge JS float math bugs in
// billing aggregations. UI converts at the boundary.
//
// `updatedAt` powers an "as of" line in the admin rate editor (H3)
// without separate audit-log spelunking — though every change still
// gets a row in audit_log via the helper.
export const rateDefaults = pgTable("rate_defaults", {
  type: resourceType("type").primaryKey(),
  ratePer30MinCents: integer("rate_per_30_min_cents").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// Physical inventory: cages, bullpens, weight room slots. Rows of
// the schedule grid. `name` is unique so seeds and admin edits can't
// double-create "Cage 1". `sortOrder` controls dropdown + grid row
// order without depending on insert order or name parsing. `active`
// lets us soft-disable a closed-down resource without losing its
// session history (the FK from sessions_billing in C3 prevents
// hard deletes anyway).
//
// No hitting/pitching subtype here — any cage can host either, and
// the actual use type for a given booking lives on the session row
// (C3). Resources stay pure "what's available."
export const resources = pgTable("resources", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  type: resourceType("type").notNull(),
  sortOrder: integer("sort_order").notNull(),
  active: boolean("active").notNull().default(true),
});

// Per-coach pricing exceptions. Composite PK on (coachId, resourceType)
// enforces "one override per (coach, resource type) forever" at the DB
// layer — no need for filtering or `ORDER BY updatedAt LIMIT 1` in
// reads. A coach can have different overrides for different resource
// types (e.g. cage default rate, bullpen discount).
//
// Read path: src/lib/billing.ts:rateForSlot already does the right
// thing — caller pre-fetches all relevant overrides into an array,
// rateForSlot picks the match or falls back to default. The DB read
// happens in the server action that calls it.
//
// No FK from sessions_billing to this table — sessions snapshot the
// rate that was charged at the time. Changing a coach's override
// today never retroactively re-bills their past sessions.
//
// updatedAt powers an "as of" line in the admin override editor (H3)
// without separate audit-log spelunking — every change still gets a
// row in audit_log via the helper.
export const coachRateOverrides = pgTable(
  "coach_rate_overrides",
  {
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: resourceType("resource_type").notNull(),
    ratePer30MinCents: integer("rate_per_30_min_cents").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.coachId, table.resourceType] }),
  ],
);

// Per-(coach, program) pay-rate override for logged program hours.
// Mirrors coach_rate_overrides but keyed on (coach, program) instead of
// (coach, resource_type): when present it wins over the program's
// default_rate_per_30_min_cents. Both FKs cascade — an override row has
// no meaning without its coach + program. Composite PK enforces one
// override per (coach, program).
export const programRateOverrides = pgTable(
  "program_rate_overrides",
  {
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    ratePer30MinCents: integer("rate_per_30_min_cents").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.coachId, table.programId] }),
  ],
);

// Billing sessions — the row that every report, schedule grid, and
// coach history reads from. Named `sessions_billing` because Auth.js
// already owns `sessions` for login sessions and the FK chaos isn't
// worth the brevity.
//
// Constraints enforced at the DB layer (NOT by Drizzle — added by
// hand in the migration):
//   - CHECK (start_at < end_at): rejects backwards/zero-duration
//     ranges. App-level Zod also catches this but the DB is the
//     final word in case of direct SQL writes.
//   - EXCLUDE USING gist (resource_id WITH =,
//       tsrange(start_at, end_at) WITH &&):
//     prevents any two rows on the same resource from overlapping.
//     Race-safe at the DB level — two simultaneous inserts can't
//     both win. Requires `CREATE EXTENSION btree_gist`.
//
// useType is nullable in the schema, but C6 server actions enforce
// "required for cage, must be NULL for bullpen/weight_room" via
// Zod since CHECK constraints can't subquery the resources table.
// Direct SQL writes can bypass this, but those are admin-only and
// audited.
//
// Block-vs-session overlap (C5): blocked_times will have its own
// EXCLUDE constraint for block-vs-block, and C6 server actions will
// also check the opposite table before insert. Cross-table EXCLUDE
// isn't supported in Postgres without a trigger function; the app-
// layer check is the v1 trade-off — race window is essentially
// zero given the user count.
//
// Indexes (added in the migration):
//   - (coach_id, start_at): D2 coach history "my sessions in May"
//   - (resource_id, start_at): F1 schedule grid lookups
//   - (start_at): E1 admin reports by date range
export const sessionsBilling = pgTable(
  "sessions_billing",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    startAt: timestamp("start_at", { mode: "date" }).notNull(),
    endAt: timestamp("end_at", { mode: "date" }).notNull(),
    useType: sessionUseType("use_type"),
    note: text("note"),
    // Provenance tag for batch operations. NULL for manually-entered
    // sessions (admin or coach UI); "historical_import" for rows
    // backfilled by I3's Excel import. Lets I4 dedupe on re-import
    // without burning insert-then-23P01 round trips, and lets us
    // selectively delete a botched historical batch without
    // touching live data.
    source: text("source"),
    // Team-rental flag: a paying group/team booked the resource, not
    // a coach's private lesson. Display surfaces show a badge next to
    // the coach name; reports + filters can split by it. Doesn't
    // affect billing math — the coach (or team-rental pseudo-coach)
    // still gets billed at their rate.
    isTeamRental: boolean("is_team_rental").notNull().default(false),
    // PFA-referred flag: PFA arranged this client for the coach. Pure
    // bookkeeping marker for Dad's offline records — payouts to the
    // coach happen outside the app. Doesn't affect what the coach owes
    // PFA. Filterable on /admin/sessions and exported in the report.
    pfaReferred: boolean("pfa_referred").notNull().default(false),
    // Prepaid online lesson: client paid PFA directly in full, PFA nets
    // the rental fee against the payout owed to the coach. On the web
    // app these sessions always bill at $0 — the actual money flow
    // happens off-app. Resource still gets blocked normally.
    isOnline: boolean("is_online").notNull().default(false),
    // Cents-per-30-min rate stamped at row creation. Decouples the
    // session's billing rate from later changes to coach_rate_overrides
    // or rate_defaults — a renegotiation today never re-bills past
    // sessions. Reports + Excel + /admin/sessions read THIS, never
    // recompute from current overrides. Online sessions get 0.
    ratePer30MinCents: integer("rate_per_30_min_cents").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("sessions_billing_coach_start_idx").on(table.coachId, table.startAt),
    index("sessions_billing_resource_start_idx").on(
      table.resourceId,
      table.startAt,
    ),
    index("sessions_billing_start_idx").on(table.startAt),
  ],
);

// Admin-created resource blocks for non-billing reasons: summer
// camps, private team rentals, HVAC repair, holidays. Coaches can't
// book a resource while it's blocked.
//
// Same DB-level constraints as sessions_billing:
//   - CHECK (start_at < end_at)
//   - EXCLUDE USING gist (resource_id, tsrange): block-vs-block
//     overlap rejected at the DB layer
//
// Block-vs-session overlap is enforced in C6 server actions
// (app-layer cross-table check) since Postgres EXCLUDE can't span
// tables. Race window is negligible for ~12-user load.
//
// `reason` is required text — surfaces in conflict error messages
// ("Cage 1 is blocked at this time for: Summer Camp 2026") so the
// person trying to book knows the situation.
//
// Index on (resource_id, start_at) for the cross-table overlap
// check from createSession in C6.
export const blockedTimes = pgTable(
  "blocked_times",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    startAt: timestamp("start_at", { mode: "date" }).notNull(),
    endAt: timestamp("end_at", { mode: "date" }).notNull(),
    reason: text("reason").notNull(),
    // QA10 W3.3: when a scheduled program OCCUPIES this resource, the
    // blocked_time is linked to the owning program block. ON DELETE CASCADE
    // so cancelling/regenerating the program block clears its occupancy.
    programScheduleBlockId: text("program_schedule_block_id").references(
      () => programScheduleBlocks.id,
      { onDelete: "cascade" },
    ),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("blocked_times_resource_start_idx").on(table.resourceId, table.startAt),
    index("blocked_times_program_block_idx").on(table.programScheduleBlockId),
  ],
);

export const paymentMethod = pgEnum("payment_method", [
  "venmo",
  "zelle",
  "check",
  "cash",
  "other",
]);

export const paymentStatus = pgEnum("payment_status", ["pending", "confirmed"]);

// Ledger of payments from a coach to PFA. One direction only — Dad's
// own payouts to coaches (the pfaReferred flag flow) happen outside
// the app. Admin-recorded payments auto-confirm (recordedBy === confirmedBy);
// coach-self-reported payments stay `pending` until an admin reviews.
//
// Only `confirmed` payments reduce a coach's outstanding balance on
// /admin/payments — pending sits in an inbox section so Dad can
// approve or reject without losing it. Soft-delete (deletedAt) so the
// audit trail keeps a record of corrections.
//
// Indexes: (coach_id, paid_at desc) for the per-coach payment list
// + balance query; (status, paid_at desc) for the pending-inbox feed.
export const coachPayments = pgTable(
  "coach_payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
    amountCents: integer("amount_cents").notNull(),
    method: paymentMethod("method").notNull(),
    paidAt: timestamp("paid_at", { mode: "date" }).notNull(),
    // Free-text: Venmo txn id, check number, etc. Optional — cash
    // payments don't have one and that's fine.
    reference: text("reference"),
    note: text("note"),
    status: paymentStatus("status").notNull().default("pending"),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => users.id),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { mode: "date" }),
    recordedAt: timestamp("recorded_at", { mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "date" }),
  },
  (table) => [
    index("coach_payments_coach_paid_idx").on(table.coachId, table.paidAt),
    index("coach_payments_status_paid_idx").on(table.status, table.paidAt),
  ],
);

export const auditAction = pgEnum("audit_action", ["create", "update", "delete"]);

// Append-only audit trail for every billing-relevant mutation. `diff`
// is JSONB so we can store the changed-keys subset for updates and
// the full snapshot for create/delete without separate columns.
// Helper in src/lib/audit.ts computes the diff shape; see comments
// there for the contract.
//
// Indexes: (entity_type, entity_id) so a billing dispute lookup
// ("show all history for session X") is a fast index seek, and (ts)
// for the admin audit log page's reverse-chronological feed.
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: auditAction("action").notNull(),
    diff: jsonb("diff"),
    ts: timestamp("ts", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_ts_idx").on(table.ts),
  ],
);

// ============================================================
// PHASE 1 — Programs, athletes, hours, attendance
// ============================================================

// Training programs (e.g. "Elite Hitting", "Speed & Agility").
//
// `cap` / `capPeriod` are DORMANT (see below): the session cap moved to
// the per-athlete enrollment (athlete_programs.cap, FEAT-11). The columns
// + their CHECK constraint are kept to avoid a destructive migration.
//
// `name` is unique so seeds + admin edits can't double-create a program,
// mirroring resources.name. Programs are never hard-deleted: use the
// `active` flag to retire one (mirrors resources.active) so historical
// hour logs + attendance keep their FK target intact. Because of this,
// the program FKs on hour_logs / attendance_sessions intentionally use
// NO cascade.
export const programs = pgTable("programs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  // DORMANT: the session cap moved to athlete_programs.cap — these two
  // columns are unused (the Programs form/actions no longer read/write
  // them), kept to avoid a destructive migration. A future cleanup
  // migration can drop them along with the cap_period enum.
  cap: integer("cap"),
  capPeriod: capPeriod("cap_period"),
  active: boolean("active").notNull().default(true),
  // Per-program default pay rate for logged hours, in cents per 30-min
  // slot. NULLABLE with no default: a program with no rate set resolves
  // to null → $0 pay until an admin sets one (QA2-9b UI). Mirrors the
  // resource-type defaults in rate_defaults, but lives on the program
  // row since program pay is per-program, not per-resource-type.
  defaultRatePer30MinCents: integer("default_rate_per_30_min_cents"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Athletes (players). Minimal Phase-1 record. `birthday` is an optional
// calendar date with no timezone, stored as Postgres `date` and surfaced
// as a "YYYY-MM-DD" string (mode: "string"). NULL = unknown (e.g. a Sling
// starter-roster import row that lacks a birthday).
export const athletes = pgTable("athletes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  birthday: date("birthday", { mode: "string" }),
  // term = normalized "Season YYYY" (e.g. "Summer 2026"), NULL when
  // unset (seed/import may omit it). archivedAt = visibility flag
  // mirroring users.deletedAt — archive is a soft hide, not a delete,
  // so attendance history is preserved (DEC-28).
  term: text("term"),
  archivedAt: timestamp("archived_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Many-to-many: which athletes are enrolled in which programs. Composite
// PK enforces one enrollment per (athlete, program). Both FKs cascade on
// delete since an enrollment row has no meaning without its parents.
export const athletePrograms = pgTable(
  "athlete_programs",
  {
    athleteId: text("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    // Per-athlete participation cap for THIS enrollment (FEAT-11 redesign):
    // cap = max present sessions; capPeriod = the window it resets over
    // (week = Sun–Sat, month = calendar month, total = whole program, no
    // reset). Both NULL = no cap. Co-required (CHECK in the migration).
    cap: integer("cap"),
    capPeriod: enrollmentCapPeriod("cap_period"),
  },
  (table) => [
    primaryKey({ columns: [table.athleteId, table.programId] }),
    index("athlete_programs_program_idx").on(table.programId),
  ],
);

// Persisted "these two athletes are NOT duplicates" decisions (#17 roster
// dedup). Detection groups athletes by normalized name + compatible
// birthday; an admin can dismiss a falsely-flagged pair so it never
// re-surfaces. The pair is stored UNORDERED in a canonical form
// (athleteAId = the lexicographically smaller id, athleteBId the larger;
// enforced in the app layer) so (X,Y) and (Y,X) dedupe to one row via the
// unique index. Both athlete FKs cascade so merging/deleting either
// athlete auto-clears the dismissal; dismissedBy set-null keeps the row if
// the acting admin is later removed.
export const athleteMergeDismissals = pgTable(
  "athlete_merge_dismissals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    athleteAId: text("athlete_a_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    athleteBId: text("athlete_b_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    dismissedBy: text("dismissed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    dismissedAt: timestamp("dismissed_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("athlete_merge_dismissals_pair_unique").on(
      table.athleteAId,
      table.athleteBId,
    ),
  ],
);

// Many-to-many: which coaches may access which programs. Composite PK
// enforces one assignment per (coach, program).
export const coachPrograms = pgTable(
  "coach_programs",
  {
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.coachId, table.programId] }),
    index("coach_programs_program_idx").on(table.programId),
  ],
);

// Coach hours logged against a program (payroll / utilization).
//
// CHECK (start_at < end_at) is hand-added in the migration, mirroring
// sessions_billing — rejects backwards / zero-duration ranges at the DB
// layer even on direct SQL writes. The program FK uses NO cascade
// because programs are soft-deleted (see programs comment).
//
// Indexes: (coach_id, start_at) for per-coach payroll windows;
// (program_id, start_at) for per-program utilization.
export const hourLogs = pgTable(
  "hour_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    startAt: timestamp("start_at", { mode: "date" }).notNull(),
    endAt: timestamp("end_at", { mode: "date" }).notNull(),
    note: text("note"),
    // Snapshot of the resolved per-30-min pay rate (cents) stamped at
    // write time, mirroring sessions_billing.rate_per_30_min_cents.
    // NULLABLE: pre-existing rows stay null (back-fill is out of scope),
    // and a new row stamps null when the program has no rate set → $0
    // pay. Reads use this snapshot, never recompute from current rates.
    ratePer30MinCents: integer("rate_per_30_min_cents"),
    // Admin "Resolve" marker for unscheduled logs (mark reviewed/acknowledged).
    // The log STAYS (real worked time/pay); a non-null reviewedAt drops it off
    // the needs-review queue. Additive + nullable, no backfill — existing rows
    // stay NULL = unreviewed.
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    reviewedBy: text("reviewed_by").references(() => users.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("hour_logs_coach_start_idx").on(table.coachId, table.startAt),
    index("hour_logs_program_start_idx").on(table.programId, table.startAt),
    index("hour_logs_start_idx").on(table.startAt),
    // Prevents duplicate hour-logs from a double-confirm/double-tap: a coach
    // can't log the same program at the same exact start/end time twice
    // (an exact (coach, program, start, end) match is always a true dup).
    uniqueIndex("hour_logs_coach_program_start_end_unique").on(
      table.coachId,
      table.programId,
      table.startAt,
      table.endAt,
    ),
  ],
);

// One attendance-taking event: a program on a single PFA-local calendar
// day. `session_date` is a calendar day (no timezone), so the day a coach
// picks is the day stored regardless of server TZ. UNIQUE(program_id,
// session_date) enforces at most one attendance session per program per
// day. Program FK uses NO cascade (programs are soft-deleted).
export const attendanceSessions = pgTable(
  "attendance_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("attendance_sessions_program_date_unique").on(
      table.programId,
      table.sessionDate,
    ),
  ],
);

// Admin-authored intended program blocks for FEAT-16 reconciliation:
// which coach is *supposed* to run which program, when. The scheduled
// coach is who SHOULD run it — coaches may still log any program per
// DEC-29; FEAT-16 reconciles these against the coach hour-logs.
//
// CHECK (start_at < end_at) is hand-added in migration 0018, mirroring
// hour_logs / sessions_billing. The program FK uses NO cascade because
// programs are soft-deleted (active = false) — history is preserved,
// same as blocked_times → resources. No overlap/EXCLUDE constraint:
// the admin authors these deliberately, overlapping blocks are allowed.
//
// Indexes: (program_id, start_at) for per-program reads;
// (scheduled_coach_id, start_at) for per-coach reconciliation — FEAT-16
// reads both directions.
// RECUR-a: a recurring program-schedule series. The admin authors a
// weekly recurrence (one or more weekdays, a wall-clock time window, a
// season start + end date) and we MATERIALIZE one program_schedule_blocks
// row per occurrence (see schedule-recurrence.ts + the series actions).
// The series row is the editable definition; the blocks are the
// materialized occurrences the grid + reconciliation already read.
//
// daysOfWeek uses the JS getUTCDay() convention: 0=Sunday .. 6=Saturday.
// startTime/endTime are PFA wall-clock "HH:MM" (24h, the format
// TimeSelect emits). startsOn/endsOn are PFA calendar dates "YYYY-MM-DD"
// (endsOn inclusive). skipDates holds cancelled-occurrence dates so a
// later edit-series regenerate won't recreate a cancelled occurrence.
//
// Program FK cascades (same as program_schedule_blocks). A series edit
// regenerates only FUTURE occurrences; past blocks stay as a historical
// record (see editProgramScheduleSeriesInternal).
export const programScheduleSeries = pgTable("program_schedule_series", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  programId: text("program_id")
    .notNull()
    .references(() => programs.id, { onDelete: "cascade" }),
  scheduledCoachId: text("scheduled_coach_id")
    .notNull()
    .references(() => users.id),
  daysOfWeek: integer("days_of_week").array().notNull(),
  // RECUR-a frequency + interval. "weekly" with interval N = every N
  // weeks; "monthly" with interval N = the same weekday/ordinal every N
  // months. Both default to weekly/1 so existing rows are unchanged.
  // interval >= 1 is enforced in the zod schema + the pure generator
  // (no DB CHECK; the codebase enforces such invariants in app code).
  frequency: recurrenceFrequency("frequency").notNull().default("weekly"),
  interval: integer("recurrence_interval").notNull().default(1),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on").notNull(),
  skipDates: text("skip_dates")
    .array()
    .notNull()
    .default(sql`'{}'`),
  note: text("note"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const programScheduleBlocks = pgTable(
  "program_schedule_blocks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    scheduledCoachId: text("scheduled_coach_id")
      .notNull()
      .references(() => users.id),
    startAt: timestamp("start_at", { mode: "date" }).notNull(),
    endAt: timestamp("end_at", { mode: "date" }).notNull(),
    note: text("note"),
    // RECUR-a: NULL for one-off blocks; set to the parent series when the
    // block is a materialized recurring occurrence. ON DELETE CASCADE so
    // deleting a series removes its occurrences.
    seriesId: text("series_id").references(() => programScheduleSeries.id, {
      onDelete: "cascade",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("program_schedule_blocks_program_start_idx").on(
      table.programId,
      table.startAt,
    ),
    index("program_schedule_blocks_coach_start_idx").on(
      table.scheduledCoachId,
      table.startAt,
    ),
    index("program_schedule_blocks_start_idx").on(table.startAt),
    index("program_schedule_blocks_series_idx").on(table.seriesId),
  ],
);

// QA10 W3.2: the FULL set of scheduled coaches for a program block (the
// primary scheduledCoachId is also a member). Reconciliation is per-coach.
export const programScheduleBlockCoaches = pgTable(
  "program_schedule_block_coaches",
  {
    blockId: text("block_id")
      .notNull()
      .references(() => programScheduleBlocks.id, { onDelete: "cascade" }),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.blockId, table.coachId] }),
    index("program_schedule_block_coaches_coach_idx").on(table.coachId),
  ],
);

// QA10 W3-polish15: per-(block, coach) accountability flag. A coach can
// cancel their assignment to a scheduled block (kind="cancelled", optional
// note), which drops the block off their confirm list and surfaces to the
// admin for review; admins later tombstone acknowledged no-shows
// (kind="no_show"). reviewedAt/reviewedBy: NULL until an admin resolves a
// "cancelled" flag; stamped at insert for an admin "no_show".
//
// The unique index makes a coach's cancel idempotent (one row per
// block/coach/kind — onConflictDoNothing); the (kind, reviewedAt) index
// powers the admin needs-review queue.
export const programBlockCoachFlags = pgTable(
  "program_block_coach_flags",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    blockId: text("block_id")
      .notNull()
      .references(() => programScheduleBlocks.id, { onDelete: "cascade" }),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
    kind: blockCoachFlagKind("kind").notNull(),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    // 'cancelled': null until an admin resolves. 'no_show': stamped at
    // insert (admin Resolve == acknowledge).
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    reviewedBy: text("reviewed_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("program_block_coach_flags_block_coach_kind_idx").on(
      table.blockId,
      table.coachId,
      table.kind,
    ),
    index("program_block_coach_flags_kind_reviewed_idx").on(
      table.kind,
      table.reviewedAt,
    ),
  ],
);

// QA10 W3.2: the full coach set for a recurring series. Materialized
// occurrences copy this set into program_schedule_block_coaches.
export const programScheduleSeriesCoaches = pgTable(
  "program_schedule_series_coaches",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => programScheduleSeries.id, { onDelete: "cascade" }),
    coachId: text("coach_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.coachId] }),
    index("program_schedule_series_coaches_coach_idx").on(table.coachId),
  ],
);

// Per-athlete present/absent mark within an attendance session. Composite
// PK enforces one record per (session, athlete). Both FKs cascade: a
// record has no meaning without its session or athlete.
export const attendanceRecords = pgTable(
  "attendance_records",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => attendanceSessions.id, { onDelete: "cascade" }),
    athleteId: text("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    present: boolean("present").notNull(),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.athleteId] }),
    index("attendance_records_athlete_idx").on(table.athleteId),
  ],
);

export type CoachPayment = typeof coachPayments.$inferSelect;
export type NewCoachPayment = typeof coachPayments.$inferInsert;

export type OrgSettings = typeof orgSettings.$inferSelect;
export type NewOrgSettings = typeof orgSettings.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Role = (typeof roleEnum.enumValues)[number];
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type AuditAction = (typeof auditAction.enumValues)[number];
export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;
export type ResourceType = (typeof resourceType.enumValues)[number];
export type RateDefault = typeof rateDefaults.$inferSelect;
export type NewRateDefault = typeof rateDefaults.$inferInsert;
export type SessionBilling = typeof sessionsBilling.$inferSelect;
export type NewSessionBilling = typeof sessionsBilling.$inferInsert;
export type SessionUseType = (typeof sessionUseType.enumValues)[number];
export type CoachRateOverride = typeof coachRateOverrides.$inferSelect;
export type NewCoachRateOverride = typeof coachRateOverrides.$inferInsert;
export type ProgramRateOverride = typeof programRateOverrides.$inferSelect;
export type NewProgramRateOverride =
  typeof programRateOverrides.$inferInsert;
export type BlockedTime = typeof blockedTimes.$inferSelect;
export type NewBlockedTime = typeof blockedTimes.$inferInsert;

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;
export type CapPeriod = (typeof capPeriod.enumValues)[number];
export type Athlete = typeof athletes.$inferSelect;
export type NewAthlete = typeof athletes.$inferInsert;
export type AthleteProgram = typeof athletePrograms.$inferSelect;
export type NewAthleteProgram = typeof athletePrograms.$inferInsert;
export type EnrollmentCapPeriod =
  (typeof enrollmentCapPeriod.enumValues)[number];
export type CoachProgram = typeof coachPrograms.$inferSelect;
export type NewCoachProgram = typeof coachPrograms.$inferInsert;
export type HourLog = typeof hourLogs.$inferSelect;
export type NewHourLog = typeof hourLogs.$inferInsert;
export type AttendanceSession = typeof attendanceSessions.$inferSelect;
export type NewAttendanceSession = typeof attendanceSessions.$inferInsert;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type NewAttendanceRecord = typeof attendanceRecords.$inferInsert;
export type ProgramScheduleBlock = typeof programScheduleBlocks.$inferSelect;
export type NewProgramScheduleBlock =
  typeof programScheduleBlocks.$inferInsert;
export type ProgramScheduleBlockCoach =
  typeof programScheduleBlockCoaches.$inferSelect;
export type NewProgramScheduleBlockCoach =
  typeof programScheduleBlockCoaches.$inferInsert;
export type ProgramScheduleSeriesCoach =
  typeof programScheduleSeriesCoaches.$inferSelect;
export type NewProgramScheduleSeriesCoach =
  typeof programScheduleSeriesCoaches.$inferInsert;
export type ProgramBlockCoachFlag =
  typeof programBlockCoachFlags.$inferSelect;
export type NewProgramBlockCoachFlag =
  typeof programBlockCoachFlags.$inferInsert;
export type BlockCoachFlagKind = (typeof blockCoachFlagKind.enumValues)[number];
