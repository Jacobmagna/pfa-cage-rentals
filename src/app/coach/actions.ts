"use server";

// Coach-side profile actions. updateOwnName lives in src/app/actions.ts (it
// covers both coach + admin and is already wired into the editable-name
// component); this file holds coach-only profile actions.
//
// 1b #25 SMS reminders: both actions are thin authz wrappers around the
// internal logic in src/lib/server/sms-actions.ts. requireSession() pins the
// actor, and the internal fns write ONLY actor.id's row — a client-supplied
// coachId is never read, so a coach cannot change another coach's SMS
// settings (no IDOR). revalidate the coach surfaces that show the prompt /
// toggle so any direct RPC caller gets fresh data. (Worker B wires the UI.)

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import {
  saveSmsSetupInternal,
  setSmsOptInInternal,
} from "@/lib/server/sms-actions";

export async function saveSmsSetup(input: unknown) {
  const session = await requireSession();
  const result = await saveSmsSetupInternal(session.user, input);
  revalidatePath("/coach");
  revalidatePath("/coach/hour-log");
  return result;
}

export async function setSmsOptIn(input: unknown) {
  const session = await requireSession();
  const result = await setSmsOptInInternal(session.user, input);
  revalidatePath("/coach");
  revalidatePath("/coach/hour-log");
  return result;
}
