import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import { getProductFormOptions, PRODUCT_TYPES } from "@/travel/catalog";
import { REGISTERABLE_TRAVEL_PRODUCT_TYPES } from "@/travel/registration";
import { ProductForm } from "../_components/product-form";
import { createProductAction } from "./actions";

// Block 3d-1 — the CREATE product screen (/travel/admin/products/new). Guarded
// operator-only. Loads the season/location/team option lists, renders the shared
// ProductForm in "create" mode, and wires the create action. ?error=<code> maps
// to a banner in the form.
//
// Skin: elevated travel — same tokens as the applications surface.

type SearchParams = Promise<{ error?: string }>;

const ERROR_COPY: Record<string, string> = {
  name_required: "A product name is required.",
  bad_type: "That product type isn't allowed.",
  price_required:
    "Enter exactly one price — a flat price, or at least one complete tier (key, label, price).",
  bad_reference: "The selected season, location, or team no longer exists.",
  "1": "Something went wrong — please try again.",
};

const REGISTERABLE = [...REGISTERABLE_TRAVEL_PRODUCT_TYPES];

export default async function NewTravelProductPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY["1"]) : null;
  const { seasons, locations, teams } = await getProductFormOptions();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          New product
        </h1>
        <Link
          href="/travel/admin/products"
          className="mt-1 text-xs font-semibold text-fg-muted transition-colors hover:text-fg"
        >
          ← Back to catalog
        </Link>
      </div>

      <div className="rounded-md border border-line bg-surface p-6">
        <ProductForm
          mode="create"
          action={createProductAction}
          productTypes={PRODUCT_TYPES}
          registerableTypes={REGISTERABLE}
          seasons={seasons}
          locations={locations}
          teams={teams}
          errorMessage={errorMessage}
        />
      </div>
    </div>
  );
}
