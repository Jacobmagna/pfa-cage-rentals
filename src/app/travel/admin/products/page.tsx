import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import {
  listAllTravelProductsForOperator,
  REGISTERABLE_TYPES,
  type OperatorCatalogProduct,
} from "@/travel/catalog";
import { setProductActiveAction } from "./actions";

// Block 3d-1 — the operator PRODUCT CATALOG list (/travel/admin/products).
// Guarded operator-only (requireTravelAccess redirects others). Lists ALL
// products (active + archived), each with an Edit link and an Archive /
// Reactivate action. "New product" → /travel/admin/products/new. ?saved=1 and
// ?error=<code> surface banners.
//
// Skin: elevated travel — sharp rounded-md, flat, hairline border on bg-surface,
// credential micro-labels, gold accent restrained. Facility tokens only.

type SearchParams = Promise<{
  saved?: string;
  error?: string;
}>;

const ERROR_COPY: Record<string, string> = {
  not_found: "That product could not be found.",
  name_required: "A product name is required.",
  bad_type: "That product type isn't allowed.",
  price_required:
    "A product needs exactly one price — a flat price or at least one tier.",
  bad_reference: "The selected season, location, or team no longer exists.",
  "1": "Something went wrong — please try again.",
};

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

// Format integer cents → "$1,234.00".
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// The price cell: flat → "$X"; tiered → "Tiered · from $min"; neither → "—"
// (shouldn't happen for a validly-created product, but archived legacy rows are
// tolerated).
function priceLabel(p: OperatorCatalogProduct): string {
  const tiers = p.priceTiers ?? [];
  if (tiers.length > 0) {
    const min = tiers.reduce(
      (m, t) => (t.priceCents < m ? t.priceCents : m),
      Number.POSITIVE_INFINITY,
    );
    return `Tiered · from ${formatUsd(min)}`;
  }
  if (p.basePriceCents !== null) return formatUsd(p.basePriceCents);
  return "—";
}

function ActiveBadge({ active }: { active: boolean }) {
  const tone = active
    ? "border-emerald/30 bg-emerald/10 text-emerald"
    : "border-line bg-surface-2 text-fg-subtle";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${tone}`}
    >
      {active ? "Active" : "Archived"}
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

function ProductCard({ product }: { product: OperatorCatalogProduct }) {
  const registerable = REGISTERABLE_TYPES.has(product.type);
  return (
    <article className="rounded-md border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-lg font-bold tracking-tight text-fg">
            {product.name}
          </h2>
          <p className="text-xs text-fg-muted">
            {product.type}
            {registerable ? " · registerable" : ""}
          </p>
        </div>
        <ActiveBadge active={product.active} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Price" value={priceLabel(product)} />
        <Field label="Season" value={product.seasonName ?? "—"} />
        <Field label="Location" value={product.locationName ?? "—"} />
        <Field label="Team" value={product.teamName ?? "—"} />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Link
          href={`/travel/admin/products/${product.id}/edit`}
          className="rounded-md border border-line bg-surface h-9 px-4 inline-flex items-center text-sm font-semibold text-fg-muted transition-colors hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Edit
        </Link>
        <form action={setProductActiveAction}>
          <input type="hidden" name="id" value={product.id} />
          <input
            type="hidden"
            name="active"
            value={product.active ? "false" : "true"}
          />
          <button
            type="submit"
            className="rounded-md border border-line bg-surface-2 h-9 px-4 text-sm font-semibold text-fg-muted transition-colors hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            {product.active ? "Archive" : "Reactivate"}
          </button>
        </form>
      </div>
    </article>
  );
}

export default async function TravelProductsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { saved, error } = await searchParams;
  const products = await listAllTravelProductsForOperator();
  const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY["1"]) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
            PFA Travel / Operator
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-fg">
            Product Catalog
          </h1>
        </div>
        <Link
          href="/travel/admin/products/new"
          className="inline-flex items-center rounded-md bg-yellow text-gold-ink h-10 px-5 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          New product
        </Link>
      </div>

      {saved ? (
        <p
          role="status"
          className="rounded-md border border-emerald/30 bg-emerald/10 px-3 py-2 text-sm text-emerald"
        >
          Saved.
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

      {products.length === 0 ? (
        <div className="rounded-md border border-line bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            No products yet. Create the first one to open registration.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
