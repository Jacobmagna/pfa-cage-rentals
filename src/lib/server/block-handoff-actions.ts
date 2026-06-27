// W3-handoff: internal mutation logic for a COACH giving away or dropping
// their own scheduled work block. Lives outside any "use server" file (same
// reason as block-flag-actions.ts) because these take the acting coach as a
// parameter — exposing them directly as RPC would let a caller forge an
// identity. The public requireSession()-gated wrappers live in
// src/app/coach/hour-log/actions.ts and pass session.user as `actor`, so a
// coach can only ever act on their OWN block membership.
//
// Two operations, both only valid while the block is still on the coach's
// confirm list (member, started, not yet logged):
//
//   • reassignOwnBlockInternal — HAND OFF: the acting coach leaves the
//     block's coach set and the chosen recipient joins it. The block then
//     appears on the recipient's schedule + confirm list (they log it and
//     get paid); the no-show derivation (needs-review.ts) follows membership,
//     so an unlogged block now lands on the RECIPIENT, not the giver. The
//     reassignment itself is the record (plus an audit row) — no 'cancelled'
//     flag, so a clean hand-off doesn't clutter the admin review queue.
//
//   • cancelOwnBlockInternal — NO COVER: insert a 'cancelled'
//     program_block_coach_flags row (the coach keeps membership). This drops
//     the block off their confirm list and surfaces it in the admin
//     needs-review queue exactly like the pre-existing admin-only path.
//
// neon-http is stateless HTTP (no transactions), so the membership swap is a
// sequence of statements ordered add → repoint-primary → remove so a
// mid-sequence failure never leaves the block coachless (worst case it
// briefly has both coaches). Each mutation is followed by a separate
// safeLogAudit (swallows + Sentry-captures audit failures).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { isLogScheduled } from "@/lib/coach-hour-log";
import {
  BlockAlreadyLoggedError,
  InvalidHandoffTargetError,
  NotAssignedToBlockError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import {
  cancelBlockSchema,
  reassignBlockSchema,
} from "@/lib/schemas/block-handoff";
import { safeLogAudit } from "./audit-helpers";

type Actor = AuthedSession["user"];

/**
 * Loads a block the acting coach may currently act on, asserting in order:
 * the block exists, the coach is a MEMBER, and the coach has not already
 * posted an hour-log matching it. Throws the matching typed error otherwise.
 * Shared by both hand-off and no-cover so the guardrail is identical.
 */
async function loadActionableBlock(actor: Actor, blockId: string) {
  const [block] = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      scheduledCoachId: programScheduleBlocks.scheduledCoachId,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new ProgramScheduleBlockNotFoundError(blockId);

  const [membership] = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(
      and(
        eq(programScheduleBlockCoaches.blockId, blockId),
        eq(programScheduleBlockCoaches.coachId, actor.id),
      ),
    )
    .limit(1);
  if (!membership) throw new NotAssignedToBlockError(blockId, actor.id);

  // Already logged? A posted hour-log for this coach, same program, with a
  // time overlap means the block already happened and was logged — it's off
  // the confirm list, so neither hand-off nor no-cover applies.
  const ownLogs = await db
    .select({
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        eq(hourLogs.coachId, actor.id),
        eq(hourLogs.programId, block.programId),
        eq(hourLogs.status, "posted"),
      ),
    );
  const alreadyLogged = isLogScheduled(
    {
      programId: block.programId,
      startMs: block.startAt.getTime(),
      endMs: block.endAt.getTime(),
    },
    ownLogs.map((l) => ({
      programId: l.programId,
      startMs: l.startAt.getTime(),
      endMs: l.endAt.getTime(),
    })),
  );
  if (alreadyLogged) throw new BlockAlreadyLoggedError(blockId);

  return block;
}

/**
 * HAND OFF: the acting coach gives their assigned block to `toCoachId`. The
 * recipient must be a different, active coach. Membership is swapped (add
 * recipient → repoint primary if the giver was it → remove giver) and the
 * change is audited as a program_schedule_block update.
 */
export async function reassignOwnBlockInternal(actor: Actor, input: unknown) {
  const { blockId, toCoachId } = reassignBlockSchema.parse(input);

  if (toCoachId === actor.id) throw new InvalidHandoffTargetError(toCoachId);

  const block = await loadActionableBlock(actor, blockId);

  // Recipient must be an active (non-deleted) coach.
  const [recipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, toCoachId),
        eq(users.role, "coach"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!recipient) throw new InvalidHandoffTargetError(toCoachId);

  const wasPrimary = block.scheduledCoachId === actor.id;

  // 1. Add recipient to the coach set (idempotent on the composite PK).
  await db
    .insert(programScheduleBlockCoaches)
    .values({ blockId, coachId: toCoachId })
    .onConflictDoNothing({
      target: [
        programScheduleBlockCoaches.blockId,
        programScheduleBlockCoaches.coachId,
      ],
    });

  // 2. If the giver was the primary scheduled coach, repoint it to the
  //    recipient so the admin grid + reconciliation stay consistent.
  if (wasPrimary) {
    await db
      .update(programScheduleBlocks)
      .set({ scheduledCoachId: toCoachId })
      .where(eq(programScheduleBlocks.id, blockId));
  }

  // 3. Remove the giver from the coach set.
  await db
    .delete(programScheduleBlockCoaches)
    .where(
      and(
        eq(programScheduleBlockCoaches.blockId, blockId),
        eq(programScheduleBlockCoaches.coachId, actor.id),
      ),
    );

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_schedule_block",
    entityId: blockId,
    action: "update",
    before: {
      handoffFromCoachId: actor.id,
      scheduledCoachId: block.scheduledCoachId,
    },
    after: {
      handoffToCoachId: toCoachId,
      scheduledCoachId: wasPrimary ? toCoachId : block.scheduledCoachId,
    },
  });

  return { blockId, toCoachId };
}

/**
 * NO COVER: the acting coach marks their assigned block as not worked (and
 * not given to anyone). Inserts a 'cancelled' flag (idempotent on the
 * (block, coach, kind) unique index), which drops the block off their
 * confirm list and surfaces it in the admin needs-review queue.
 */
export async function cancelOwnBlockInternal(actor: Actor, input: unknown) {
  const { blockId, note } = cancelBlockSchema.parse(input);
  const trimmedNote = note?.trim() || null;

  await loadActionableBlock(actor, blockId);

  const [flag] = await db
    .insert(programBlockCoachFlags)
    .values({
      blockId,
      coachId: actor.id,
      kind: "cancelled",
      note: trimmedNote,
      createdBy: actor.id,
    })
    .onConflictDoNothing({
      target: [
        programBlockCoachFlags.blockId,
        programBlockCoachFlags.coachId,
        programBlockCoachFlags.kind,
      ],
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_block_coach_flag",
    entityId: flag?.id ?? `${blockId}:${actor.id}`,
    action: "create",
    after: flag as unknown as Record<string, unknown>,
  });

  return { blockId };
}
