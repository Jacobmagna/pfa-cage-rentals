import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AppShell } from "@/app/_components/app-shell";

// Coach detail page — H2 ships the route + identity card so the
// /admin/coaches row links work; rate-override UI lands in H3.

type Params = Promise<{ id: string }>;

export default async function AdminCoachDetailPage({
  params,
}: {
  params: Params;
}) {
  await requireRole("admin");
  const { id } = await params;

  const [coach] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!coach || coach.role !== "coach") notFound();

  return (
    <AppShell role="admin">
      <Link
        href="/admin/coaches"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All coaches
      </Link>

      <div className="space-y-1.5 mb-6">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Coach
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {coach.name ?? coach.email}
        </h1>
        <p className="text-sm text-fg-muted">{coach.email}</p>
        <p className="text-xs text-fg-subtle font-mono tabular-nums">
          Joined{" "}
          {coach.createdAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface p-5">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          Phase 7 · H3
        </p>
        <h3 className="mt-1 text-base font-semibold text-fg">
          Rate overrides
        </h3>
        <p className="mt-1.5 text-sm text-fg-muted">
          Per-resource-type rate overrides for this coach land in H3. Until
          then, this coach is billed at the default rates.
        </p>
      </div>
    </AppShell>
  );
}
