import { redirect } from "next/navigation";
import { requireRole } from "@/lib/authz";

// QA3-1: Programs moved under Hour Log (/admin/hour-log/programs). This
// stub keeps old bookmarks / links from 404ing by redirecting to the new
// route. Auth-gated so the redirect never runs for a non-admin.
export default async function AdminProgramsRedirect() {
  await requireRole("admin");
  redirect("/admin/hour-log/programs");
}
