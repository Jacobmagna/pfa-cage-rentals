import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import {
  getTravelInvoiceStatusCounts,
  listTravelInvoicesForOperator,
  TRAVEL_INVOICE_STATUSES,
  type OperatorInvoice,
} from "@/travel/catalog";

// Block 3d-2 — the operator REGISTRATION / DUES list (/travel/admin/registrations).
// Guarded operator-only (requireTravelAccess redirects others). READ-ONLY: it
// shows who has registered (each Block-3c registration made exactly one invoice)
// and what they owe. Recording payments is Block 4 — there are NO write actions
// here. Reads ?status= (default "all") to pick the tab; the tabs mirror the
// applications queue and carry per-status counts.
//
// Skin: elevated travel — sharp rounded-md, flat, hairline border on bg-surface,
// credential micro-labels, gold accent restrained. Facility tokens only.

type SearchParams = Promise<{
  status?: string;
}>;

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

// The tab set: "All" plus every invoice status.
const TABS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  ...TRAVEL_INVOICE_STATUSES.map((s) => ({
    key: s,
    label: s.charAt(0).toUpperCase() + s.slice(1),
  })),
];

function parseStatus(raw: string | undefined): string {
  return raw && (TRAVEL_INVOICE_STATUSES as readonly string[]).includes(raw)
    ? raw
    : "all";
}

// Format integer cents → "$1,234.00".
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Status → badge tone. pending/scheduled → warning gold; partial → amber-ish
// gold too (still owed); paid → success green; refunded/void → muted.
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "paid"
      ? "border-emerald/30 bg-emerald/10 text-emerald"
      : status === "refunded" || status === "void"
        ? "border-line bg-surface-2 text-fg-subtle"
        : "border-yellow/30 bg-yellow/10 text-gold";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${tone}`}
    >
      {status}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className={LABEL}>{label}</p>
      <p className="text-sm text-fg">{value}</p>
    </div>
  );
}

function InvoiceCard({ invoice }: { invoice: OperatorInvoice }) {
  const created = invoice.createdAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const productLine = invoice.teamName
    ? `${invoice.productName ?? "—"} · ${invoice.teamName}`
    : (invoice.productName ?? "—");

  return (
    <article className="rounded-md border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-lg font-bold tracking-tight text-fg">
            {invoice.athleteName ?? "—"}
          </h2>
          <p className="text-xs text-fg-muted">{productLine}</p>
        </div>
        <StatusBadge status={invoice.status} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Guardian" value={invoice.guardianName ?? "—"} />
        <Field label="Email" value={invoice.guardianEmail ?? "—"} />
        <Field label="Registered" value={created} />
        <Field label="Total" value={formatUsd(invoice.totalCents)} />
        <Field label="Balance owed" value={formatUsd(invoice.balanceCents)} />
      </div>
    </article>
  );
}

export default async function TravelRegistrationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { status } = await searchParams;
  const active = parseStatus(status);

  const [invoices, counts] = await Promise.all([
    listTravelInvoicesForOperator(active),
    getTravelInvoiceStatusCounts(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          Registrations &amp; Dues
        </h1>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          const count = counts[tab.key] ?? 0;
          return (
            <Link
              key={tab.key}
              href={`/travel/admin/registrations?status=${tab.key}`}
              className={`rounded-md border px-4 h-9 inline-flex items-center gap-2 text-sm font-semibold transition-colors ${
                isActive
                  ? "border-yellow/40 bg-yellow/10 text-gold"
                  : "border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong"
              }`}
            >
              {tab.label}
              <span className="text-[11px] font-semibold text-fg-subtle">
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {invoices.length === 0 ? (
        <div className="rounded-md border border-line bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">No registrations yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {invoices.map((invoice) => (
            <InvoiceCard key={invoice.id} invoice={invoice} />
          ))}
        </div>
      )}
    </div>
  );
}
