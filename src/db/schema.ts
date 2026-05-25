import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const roleEnum = pgEnum("role", ["coach", "admin"]);
export const resourceType = pgEnum("resource_type", [
  "cage",
  "bullpen",
  "weight_room",
]);
export const sessionUseType = pgEnum("use_type", ["hitting", "pitching"]);

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
  role: roleEnum("role").notNull().default("coach"),
  // Payment handles. Coach-facing surfaces never expose these to other
  // coaches; admin sees them on /admin/coaches/[id] and /admin/payments
  // as reconciliation hints. NULL = not set. Stored without the @
  // prefix (Venmo) — the UI prepends it on display.
  venmoHandle: text("venmo_handle"),
  zelleContact: text("zelle_contact"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
});

// Org-wide settings singleton. One row with id='default' (seeded in
// the migration). Holds the handles coaches will deep-link to when
// paying PFA — separate from any one admin's personal handles so Dad
// can change the receiver without touching his user record. The
// `pfaDisplayName` ("Pay PFA Sports") is what the coach UI shows on
// the Pay button label.
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
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("blocked_times_resource_start_idx").on(table.resourceId, table.startAt),
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
export type BlockedTime = typeof blockedTimes.$inferSelect;
export type NewBlockedTime = typeof blockedTimes.$inferInsert;
