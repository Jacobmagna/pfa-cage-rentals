import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { rateDefaults } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { getOrgSettings } from "@/lib/server/handles-actions";
import { OrgSettingsCard } from "./_components/org-settings-card";
import { RateDefaultsCard } from "./_components/rate-defaults-card";

// /admin/settings — org-wide configuration.
//
// Today: PFA Zelle contact + display name. Venmo support was removed
// 2026-05-25 because the business Venmo account charges fees on
// incoming payments. The column stays in the schema (dormant) in case
// we ever reintroduce a non-fee payment rail. pfaDisplayName is the
// label rendered on the coach-side pay button ("Pay PFA Sports").
//
// Future surfaces likely live here: default rates, theme, slack
// webhook, etc. Each gets its own card so the page stays scannable.

export default async function AdminSettingsPage() {
  await requireRole("admin");
  const [settings, rateRows] = await Promise.all([
    getOrgSettings(),
    db.select().from(rateDefaults).orderBy(asc(rateDefaults.type)),
  ]);

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
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-fg-muted">
          Org-wide configuration: PFA payment handle + default rental rates.
        </p>
      </div>

      <div className="space-y-6">
        <OrgSettingsCard
          initialPfaDisplayName={settings.pfaDisplayName}
          initialPfaZelleContact={settings.pfaZelleContact}
        />

        <RateDefaultsCard rows={rateRows} />
      </div>
    </>
  );
}
