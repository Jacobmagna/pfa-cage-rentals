// Shared audit-log insert wrapper. Extracted verbatim from
// hour-log-actions.ts so multiple internal-mutation modules (hour log,
// athlete roster, …) share the same swallow-and-Sentry-capture
// behavior.
//
// Why swallow: under neon-http there are no transactions, so a
// successful mutation can't be rolled back if the follow-up audit
// insert fails. Rather than surface a logging hiccup to the caller
// (and pretend the mutation itself failed), we capture to Sentry and
// move on — the data write stands, the audit gap is alerted.

import * as Sentry from "@sentry/nextjs";
import { logAudit } from "@/lib/audit";

export async function safeLogAudit(
  ...args: Parameters<typeof logAudit>
): Promise<void> {
  try {
    await logAudit(...args);
  } catch (auditErr) {
    Sentry.captureException(auditErr, {
      tags: { component: "audit", entityType: args[1].entityType },
      extra: { input: args[1] },
    });
    console.error("[audit] insert failed:", auditErr);
  }
}
