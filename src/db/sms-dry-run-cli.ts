// 1b #25 — SMS reminder dry-run / inspection CLI.
//
// Computes WHO would be texted tonight's reminder (coaches who had scheduled
// work yesterday Pacific that they didn't log, opted in, with a valid phone)
// and PRINTS them — name, masked phone, and the exact rendered body. Sends
// NOTHING and writes NOTHING (it calls runSmsReminders({ dryRun: true })).
// Use it against a dev branch (or prod read replica) to eyeball exactly who
// would get a text before flipping the capability on.
//
// Usage:
//   npm run sms:dry-run

import { config } from "dotenv";
config({ path: ".env.local" });

import { renderReminderBody } from "@/lib/sms/client";
import { runSmsReminders } from "@/lib/server/sms-reminders";

/** Masks all but the last 4 digits of an E.164 number for printing. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length <= 4) return "***";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const summary = await runSmsReminders({ dryRun: true });

  if (summary.status !== "dry-run") {
    // runSmsReminders with dryRun:true always returns "dry-run"; guard.
    console.log(`Unexpected status: ${summary.status}`);
    return;
  }

  const { window, recipients } = summary;
  const link = `${process.env.AUTH_URL ?? ""}/coach/hour-log`;

  console.log("");
  console.log("=== SMS Reminders — DRY RUN (nothing sent, nothing written) ===");
  console.log(`Reminder for Pacific date: ${window.forDate}`);
  console.log(
    `  Window (UTC): ${window.startUtc.toISOString()}  →  ${window.endUtc.toISOString()}`,
  );
  console.log(`Would-be recipients: ${recipients.length}`);
  console.log("");

  if (recipients.length > 0) {
    const COL_NAME = 28;
    const COL_PHONE = 18;
    console.log(pad("COACH", COL_NAME) + pad("PHONE", COL_PHONE) + "COACH ID");
    console.log("-".repeat(COL_NAME + COL_PHONE + 36));
    for (const r of recipients) {
      console.log(
        pad(r.name ?? "(no name)", COL_NAME) +
          pad(maskPhone(r.phone), COL_PHONE) +
          r.coachId,
      );
    }
    console.log("");
    console.log("--- message body each recipient would receive ---");
    console.log(renderReminderBody(link));
  } else {
    console.log("No coaches to remind for this date.");
  }
  console.log("");
}

main().catch((err) => {
  console.error("sms dry-run failed:", err);
  process.exit(1);
});
