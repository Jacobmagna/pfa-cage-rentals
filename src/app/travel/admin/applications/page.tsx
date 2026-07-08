import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import {
  listApplicationsForOperator,
  type ApplicationStatus,
  type OperatorApplication,
} from "@/travel/applications";
import { acceptAction, declineAction } from "./actions";

// Operator application-review queue (/travel/admin/applications). Guarded
// operator-only (requireTravelAccess redirects others). Reads ?status= (default
// pending) to pick the tab; ?accepted / ?declined / ?error surface a banner.
//
// Skin: elevated travel — sharp rounded-md, flat, 1px border-line on bg-surface,
// credential micro-labels, gold accent restrained. Facility tokens only.

type SearchParams = Promise<{
  status?: string;
  accepted?: string;
  declined?: string;
  error?: string;
}>;

const TABS: { key: ApplicationStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "accepted", label: "Accepted" },
  { key: "declined", label: "Declined" },
];

const EMPTY_COPY: Record<ApplicationStatus, string> = {
  pending: "No pending applications.",
  accepted: "No accepted applications.",
  declined: "No declined applications.",
};

const ERROR_COPY: Record<string, string> = {
  not_found: "That application could not be found.",
  already_decided: "That application was already reviewed.",
  "1": "Something went wrong — please try again.",
};

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";
const INPUT =
  "w-full rounded-md border border-line bg-page h-9 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";

function parseStatus(raw: string | undefined): ApplicationStatus {
  return raw === "accepted" || raw === "declined" ? raw : "pending";
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "accepted"
      ? "border-emerald/30 bg-emerald/10 text-emerald"
      : status === "declined"
        ? "border-danger/30 bg-danger/10 text-danger"
        : "border-yellow/30 bg-yellow/10 text-gold";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${tone}`}
    >
      {status}
    </span>
  );
}

// One labeled field on a card ("PARENT", "TEAM", …).
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className={LABEL}>{label}</p>
      <p className="text-sm text-fg">{value}</p>
    </div>
  );
}

function ApplicationCard({ app }: { app: OperatorApplication }) {
  const athleteName = `${app.athleteFirstName} ${app.athleteLastName}`;
  const parentName = `${app.parentFirstName} ${app.parentLastName}`;
  const positions = app.athletePositions || "—";
  const gradYear = app.athleteGradYear ? String(app.athleteGradYear) : "—";
  const submitted = app.createdAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <article className="rounded-md border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-lg font-bold tracking-tight text-fg">
            {athleteName}
          </h2>
          <p className="text-xs text-fg-muted">
            Grad {gradYear} · {positions}
          </p>
        </div>
        <StatusPill status={app.status} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <Field label="Parent / guardian" value={parentName} />
        <Field label="Team applied to" value={app.teamName ?? "—"} />
        <Field label="Email" value={app.parentEmail} />
        <Field label="Phone" value={app.parentPhone ?? "—"} />
        <Field label="Submitted" value={submitted} />
      </div>

      {app.message ? (
        <div className="mt-4 space-y-0.5 border-t border-line pt-4">
          <p className={LABEL}>Message</p>
          <p className="whitespace-pre-line text-sm text-fg-muted">
            {app.message}
          </p>
        </div>
      ) : null}

      {app.status !== "pending" && app.reviewNote ? (
        <div className="mt-4 space-y-0.5 border-t border-line pt-4">
          <p className={LABEL}>Review note</p>
          <p className="whitespace-pre-line text-sm text-fg-muted">
            {app.reviewNote}
          </p>
        </div>
      ) : null}

      {app.status === "pending" ? (
        <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end sm:justify-between">
          <form action={declineAction} className="flex-1 space-y-1.5">
            <input type="hidden" name="id" value={app.id} />
            <label htmlFor={`note-${app.id}`} className={LABEL}>
              Decline note (optional)
            </label>
            <div className="flex gap-2">
              <input
                id={`note-${app.id}`}
                name="note"
                placeholder="Reason (optional)"
                className={INPUT}
              />
              <button
                type="submit"
                className="shrink-0 rounded-md border border-line bg-surface-2 h-9 px-4 text-sm font-semibold text-fg-muted transition-colors hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
              >
                Decline
              </button>
            </div>
          </form>

          <form action={acceptAction} className="sm:pb-0">
            <input type="hidden" name="id" value={app.id} />
            <button
              type="submit"
              className="w-full rounded-md bg-yellow text-gold-ink h-9 px-5 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40 sm:w-auto"
            >
              Accept
            </button>
          </form>
        </div>
      ) : null}
    </article>
  );
}

export default async function TravelApplicationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { status, accepted, declined, error } = await searchParams;
  const active = parseStatus(status);
  const applications = await listApplicationsForOperator(active);

  const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY["1"]) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          Applications / Tryouts
        </h1>
      </div>

      {accepted ? (
        <p
          role="status"
          className="rounded-md border border-emerald/30 bg-emerald/10 px-3 py-2 text-sm text-emerald"
        >
          Application accepted — the family will be onboarded by email.
        </p>
      ) : null}
      {declined ? (
        <p
          role="status"
          className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-muted"
        >
          Application declined.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="flex gap-2">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={`/travel/admin/applications?status=${tab.key}`}
              className={`rounded-md border px-4 h-9 inline-flex items-center text-sm font-semibold transition-colors ${
                isActive
                  ? "border-yellow/40 bg-yellow/10 text-gold"
                  : "border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {applications.length === 0 ? (
        <div className="rounded-md border border-line bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">{EMPTY_COPY[active]}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {applications.map((app) => (
            <ApplicationCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
