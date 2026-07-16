import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTravelAccess } from "@/travel/authz";
import {
  getProductFormOptions,
  getTravelProduct,
  PRODUCT_TYPES,
} from "@/travel/catalog";
import { REGISTERABLE_TRAVEL_PRODUCT_TYPES } from "@/travel/registration";
import { ProductForm } from "../../_components/product-form";
import { updateProductAction } from "./actions";

// Block 3d-1 — the EDIT product screen (/travel/admin/products/[id]/edit).
// Guarded operator-only. Pre-fills the shared ProductForm from the product's raw
// row; a missing id redirects back to the catalog with ?error=not_found. The
// hidden id field rides along so the update action can target the row.
//
// Skin: elevated travel — same tokens as the create + applications surfaces.

type Params = Promise<{ id: string }>;
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

export default async function EditTravelProductPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { id } = await params;
  const product = await getTravelProduct(id);
  if (!product) redirect("/travel/admin/products?error=not_found");

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
          Edit product
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
          mode="edit"
          action={updateProductAction}
          productId={product.id}
          productTypes={PRODUCT_TYPES}
          registerableTypes={REGISTERABLE}
          seasons={seasons}
          locations={locations}
          teams={teams}
          initial={{
            name: product.name,
            type: product.type,
            seasonId: product.seasonId,
            locationId: product.locationId,
            teamId: product.teamId,
            description: product.description,
            basePriceCents: product.basePriceCents,
            priceTiers: product.priceTiers,
            monthlyInstallmentCents: product.monthlyInstallmentCents,
            active: product.active,
          }}
          errorMessage={errorMessage}
        />
      </div>
    </div>
  );
}
