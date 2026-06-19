import { redirect } from "next/navigation";
import { requireRole } from "@/lib/authz";

// The old /admin/cage-rentals stats-hero + clickable-box dashboard was
// retired: the Rentals section now uses a top menu bar (RentalsSubnav) with
// the Schedule as the main landing. The top "Rentals" tab points straight at
// /admin/schedule; this route stays as a redirect so any lingering links
// (bookmarks, in-app hrefs) still resolve to the new main view.
export default async function CageRentalsRedirect() {
  await requireRole("admin");
  redirect("/admin/schedule");
}
