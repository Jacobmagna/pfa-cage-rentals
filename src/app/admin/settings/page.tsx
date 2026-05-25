import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { getOrgSettings } from "@/lib/server/handles-actions";
import { OrgSettingsCard } from "./_components/org-settings-card";

// /admin/settings — org-wide configuration.
//
// Today: PFA payment handles + display name (Phase P3). The
// pfaVenmoHandle / pfaZelleContact are the values P4's coach
// payments page will deep-link to when a coach taps "Pay PFA."
// pfaDisplayName is the label rendered on those buttons ("Pay
// PFA Sports via Venmo").
//
// Future surfaces likely live here: default rates, theme, slack
// webhook, etc. Each gets its own card so the page stays scannable.

export default async function AdminSettingsPage() {
  await requireRole("admin");
  const settings = await getOrgSettings();

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-8 space-y-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-fg-muted">
          Org-wide configuration. Today: payment handles coaches use to
          pay PFA.
        </p>
      </div>

      <OrgSettingsCard
        initialPfaDisplayName={settings.pfaDisplayName}
        initialPfaVenmoHandle={settings.pfaVenmoHandle}
        initialPfaZelleContact={settings.pfaZelleContact}
      />
    </>
  );
}
