import { Clock } from "lucide-react";
import { requireSession } from "@/lib/authz";

export default async function CoachHourLogPage() {
  await requireSession();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Hour Log</h1>
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
        <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
        <p className="text-fg-muted">Coming soon</p>
      </div>
    </div>
  );
}
