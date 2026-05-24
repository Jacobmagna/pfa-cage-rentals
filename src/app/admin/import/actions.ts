"use server";

// Public server actions for the historical Excel import. Thin authz
// wrapper around src/lib/server/import-actions.ts. Two-stage flow
// driven by useActionState:
//   stage="preview" → parse the file, return groups + counts
//   stage="committed" → re-parse the same file, apply decisions, insert
//
// File is re-uploaded with the commit POST because Next.js form-action
// state doesn't persist file inputs across renders; the client keeps
// the user's selection in <input type="file"> and re-submits it.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  executeCommitPlan,
  previewImport,
  type CommitResult,
  type PreviewResult,
} from "@/lib/server/import-actions";
import type { Decision, DecisionAction } from "@/lib/import/commit";

export type ImportFormState =
  | { stage: "idle" }
  | { stage: "preview"; fileName: string; preview: PreviewResult }
  | { stage: "committed"; result: CommitResult }
  | { stage: "error"; message: string };

export async function previewOrCommitImport(
  _prev: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const session = await requireRole("admin");

  const file = formData.get("xlsx");
  if (!(file instanceof File) || file.size === 0) {
    return { stage: "error", message: "Please choose an .xlsx file to upload." };
  }
  const buf = Buffer.from(await file.arrayBuffer());

  const intent = formData.get("intent")?.toString();

  if (intent === "commit") {
    const decisions = parseDecisions(formData.get("decisions")?.toString());
    try {
      const result = await executeCommitPlan(session.user, buf, decisions);
      revalidatePath("/admin/schedule");
      revalidatePath("/admin/sessions");
      revalidatePath("/admin/coaches");
      return { stage: "committed", result };
    } catch (err) {
      return {
        stage: "error",
        message: err instanceof Error ? err.message : "Commit failed",
      };
    }
  }

  // Default: preview
  try {
    const preview = await previewImport(buf);
    return { stage: "preview", fileName: file.name, preview };
  } catch (err) {
    return {
      stage: "error",
      message: err instanceof Error ? err.message : "Failed to parse the workbook",
    };
  }
}

function parseDecisions(raw: string | undefined): Decision[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Decision[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { rawName, action, mappedUserId } = item as Record<string, unknown>;
      if (typeof rawName !== "string") continue;
      if (!isDecisionAction(action)) continue;
      const d: Decision = { rawName, action };
      if (action === "map" && typeof mappedUserId === "string") {
        d.mappedUserId = mappedUserId;
      }
      out.push(d);
    }
    return out;
  } catch {
    return [];
  }
}

function isDecisionAction(v: unknown): v is DecisionAction {
  return v === "auto" || v === "map" || v === "create" || v === "skip";
}
