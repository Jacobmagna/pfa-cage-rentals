// Historical import — internal logic. Public wrapper lives at
// src/app/admin/import/actions.ts. Pattern mirrors session-actions.ts:
// parameterized actor, no requireRole inside (the public wrapper guards),
// safeLogAudit swallows audit failures without blocking the mutation.

import * as Sentry from "@sentry/nextjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { resources, sessionsBilling, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import {
  buildCommitPlan,
  buildGroupSummaries,
  type Decision,
  type ExistingUserLite,
  type GroupSummary,
} from "@/lib/import/commit";
import { normalizeSessions, type NormalizedSession } from "@/lib/import/normalize";
import { parseWorkbook } from "@/lib/import/parse";
import { pfaWallClockToUtc } from "@/lib/timezone";

export type PreviewResult = {
  totalParsed: number;
  groups: GroupSummary[];
  unknownResources: string[];
};

export type CommitResult = {
  created: number;
  skippedOverlaps: number;
  skippedByPlan: { rawName: string; reason: string; count: number }[];
  errored: { sessionDescription: string; message: string }[];
  newCoachesCreated: number;
};

// Parses the uploaded workbook and returns groups + counts. Pure-ish:
// reads existing user names from DB but doesn't mutate anything.
export async function previewImport(file: ArrayBuffer | Buffer): Promise<PreviewResult> {
  const rawSessions = await parseWorkbook(file);
  const normalized = normalizeSessions(rawSessions);
  const existingUsers = await fetchExistingUserLites();
  const groups = buildGroupSummaries(normalized, existingUsers);
  return { totalParsed: rawSessions.length, groups, unknownResources: [] };
}

// Applies the admin's decisions to the parsed file and inserts. Re-parses
// the same file from the uploaded buffer (deterministic). Sequential
// inserts because neon-http has no transactions; overlap violations are
// caught per-row and reported rather than aborting the batch.
export async function executeCommitPlan(
  actor: AuthedSession["user"],
  file: ArrayBuffer | Buffer,
  decisions: Decision[],
): Promise<CommitResult> {
  const rawSessions = await parseWorkbook(file);
  const normalized = normalizeSessions(rawSessions);
  const existingUsers = await fetchExistingUserLites();
  const plan = buildCommitPlan(normalized, decisions, existingUsers);

  // Create new coach users first so their ids exist for session inserts.
  const newCoachIdByKey = new Map<string, string>();
  for (const planned of plan.coachUsers.toCreate.values()) {
    try {
      const [row] = await db
        .insert(users)
        .values({
          name: planned.name,
          email: planned.email,
          role: "coach",
        })
        .returning({ id: users.id });
      newCoachIdByKey.set(planned.key, row.id);
      await safeLogAudit({
        actorUserId: actor.id,
        entityType: "user",
        entityId: row.id,
        action: "create",
        after: { name: planned.name, email: planned.email, role: "coach", source: "historical_import" },
      });
    } catch (err) {
      // Email collision (e.g. two parallel imports) — try to look up the existing user.
      const existing = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.email, planned.email))
        .limit(1);
      if (existing[0]) {
        newCoachIdByKey.set(planned.key, existing[0].id);
      } else {
        Sentry.captureException(err, {
          tags: { component: "import", phase: "create-coach" },
          extra: { coach: planned },
        });
        throw err;
      }
    }
  }

  // Resolve resourceName → resourceId once.
  const allResources = await db
    .select({ id: resources.id, name: resources.name })
    .from(resources);
  const resourceIdByName = new Map(allResources.map((r) => [r.name, r.id]));

  let created = 0;
  let skippedOverlaps = 0;
  const errored: CommitResult["errored"] = [];

  for (const planned of plan.sessionsToInsert) {
    const coachId =
      planned.coachKey.startsWith("existing:")
        ? planned.coachKey.slice("existing:".length)
        : newCoachIdByKey.get(planned.coachKey);
    if (!coachId) {
      errored.push({
        sessionDescription: describeSession(planned.source),
        message: `coach key not resolved: ${planned.coachKey}`,
      });
      continue;
    }

    const resourceId = resourceIdByName.get(planned.source.resourceName);
    if (!resourceId) {
      errored.push({
        sessionDescription: describeSession(planned.source),
        message: `resource not found: ${planned.source.resourceName}`,
      });
      continue;
    }

    const startAt = pfaWallClockToUtc(planned.source.date, planned.source.startTime);
    const endAt = pfaWallClockToUtc(planned.source.date, planned.source.endTime);

    try {
      const [row] = await db
        .insert(sessionsBilling)
        .values({
          coachId,
          resourceId,
          startAt,
          endAt,
          useType: planned.source.useTypeHint,
          note: planned.note,
          createdBy: actor.id,
        })
        .returning({ id: sessionsBilling.id });
      created += 1;
      await safeLogAudit({
        actorUserId: actor.id,
        entityType: "session",
        entityId: row.id,
        action: "create",
        after: {
          coachId,
          resourceId,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          useType: planned.source.useTypeHint,
          note: planned.note,
          source: "historical_import",
          sourceTab: planned.source.sourceTab,
          rawName: planned.source.rawName,
        },
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        skippedOverlaps += 1;
      } else {
        errored.push({
          sessionDescription: describeSession(planned.source),
          message: err instanceof Error ? err.message : String(err),
        });
        Sentry.captureException(err, {
          tags: { component: "import", phase: "insert-session" },
          extra: { planned },
        });
      }
    }
  }

  return {
    created,
    skippedOverlaps,
    skippedByPlan: plan.skipped,
    errored,
    newCoachesCreated: newCoachIdByKey.size,
  };
}

async function fetchExistingUserLites(): Promise<ExistingUserLite[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users);
}

function describeSession(s: NormalizedSession): string {
  return `${s.date} ${s.startTime}-${s.endTime} ${s.resourceName} (${s.rawName})`;
}

function isExclusionViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "23P01") {
    return true;
  }
  if (err instanceof Error && err.cause) return isExclusionViolation(err.cause);
  return false;
}

async function safeLogAudit(...args: Parameters<typeof logAudit> extends [unknown, infer I] ? [I] : never): Promise<void> {
  try {
    await logAudit(db, args[0]);
  } catch (auditErr) {
    Sentry.captureException(auditErr, {
      tags: { component: "audit", phase: "import" },
    });
    console.error("[audit] insert failed during import:", auditErr);
  }
}
