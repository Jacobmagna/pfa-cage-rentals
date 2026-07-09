// Travel (Block 4b-1) — thin Stripe REST client for the travel billing rail.
// Ported from Northstar's src/lib/stripe/client.ts (no `stripe` npm dep; plain
// `fetch`), with ALL Stripe Connect stripped: this is a SINGLE Stripe account,
// so there is NO `stripeAccount` param, NO `Stripe-Account` header, and NO
// connected-account resolution anywhere. Card-on-file / off-session / SetupIntent
// helpers are DELIBERATELY NOT ported (they land in Block 4b-2).
//
// A thin REST primitive, a typed error, a config helper that returns null when
// unconfigured (so the whole Stripe path stays DORMANT in local/CI), the pre-live
// live-charge gate, the webhook signature verifier, and the three money-path
// helpers we need now: createStripeCustomer, createPaymentCheckoutSession,
// createRefund.

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

/**
 * The Stripe config from the environment, or `null` when unconfigured. Reads
 * STRIPE_SECRET_KEY; returns null when it's unset/empty → the entire Stripe
 * path stays DORMANT in local/CI. NEVER throws at import time (just reads
 * process.env on call).
 */
export function stripeConfig(): { secretKey: string } | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || secretKey.trim().length === 0) return null;
  return { secretKey };
}

// ---------------------------------------------------------------------------
// Pre-live LIVE-CHARGE GATE (belt-and-suspenders).
//
// The platform runs in Stripe TEST mode (sk_test_…) until a deliberate go-live.
// To make it IMPOSSIBLE for a real card to be charged before that moment, every
// money-moving Stripe call (createPaymentCheckoutSession / createRefund) calls
// `assertChargeAllowed()` as its FIRST statement — BEFORE any network I/O. The
// gate refuses a LIVE charge unless the explicit STRIPE_LIVE_OK flag is set, so
// flipping to live keys alone is NOT enough; a second, separate switch must be
// thrown. TEST mode is always allowed (so staging QA keeps working), and an
// unconfigured Stripe refuses to move money.
//
// These helpers are PURE env reads (no I/O).
// ---------------------------------------------------------------------------

/** "test" | "live" | "unconfigured", derived from the STRIPE_SECRET_KEY prefix. */
export function stripeMode(): "test" | "live" | "unconfigured" {
  const config = stripeConfig();
  if (!config) return "unconfigured";
  return config.secretKey.startsWith("sk_live_") ? "live" : "test";
}

/** Whether the explicit live-charge gate flag STRIPE_LIVE_OK is set truthy (1/true/yes/on, case-insensitive, trimmed). */
export function liveChargeFlagSet(): boolean {
  const v = (process.env.STRIPE_LIVE_OK ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** True ONLY when live keys are present AND the live-charge flag is explicitly set — the (dangerous) armed state. */
export function liveChargesArmed(): boolean {
  return stripeMode() === "live" && liveChargeFlagSet();
}

/**
 * Belt-and-suspenders gate. Call at the TOP of EVERY money-moving Stripe call.
 *  - unconfigured  → throw StripeError (refuse to move money)
 *  - test mode     → ALWAYS allowed (staging QA must keep working)
 *  - live mode     → allowed ONLY when STRIPE_LIVE_OK is explicitly set; else throw.
 * Result: a real card can NEVER be charged before a deliberate go-live.
 */
export function assertChargeAllowed(): void {
  const mode = stripeMode();
  if (mode === "unconfigured") {
    throw new StripeError(null, "live_gate", "stripe_unconfigured",
      "Stripe is not configured — refusing to move money");
  }
  if (mode === "live" && !liveChargeFlagSet()) {
    throw new StripeError(null, "live_gate", "live_charges_not_armed",
      "Refusing a LIVE Stripe charge: STRIPE_LIVE_OK is not set (pre-live live-charge gate)");
  }
}

// ---------------------------------------------------------------------------
// Typed request error
// ---------------------------------------------------------------------------

export class StripeError extends Error {
  readonly code = "STRIPE_REQUEST_FAILED" as const;
  constructor(
    /** HTTP status of the failed response, or null if unknown. */
    public readonly httpStatus: number | null,
    /** Stripe's error.type (e.g. "card_error", "invalid_request_error"). */
    public readonly stripeType: string | null,
    /** Stripe's error.code (e.g. "resource_missing"), when present. */
    public readonly stripeCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

// ---------------------------------------------------------------------------
// Form-body encoding — Stripe's API takes application/x-www-form-urlencoded.
// We accept a FLAT object of string/number/boolean values; nested keys like
// "metadata[orderId]" are passed as flat string keys by the caller (Stripe
// reads bracketed keys natively). undefined/null values are omitted.
// ---------------------------------------------------------------------------

export function toFormBody(
  obj: Record<string, string | number | boolean | null | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

// ---------------------------------------------------------------------------
// Request primitive — SINGLE ACCOUNT (no Stripe-Account header / no Connect).
// ---------------------------------------------------------------------------

export type StripeRequestOptions = {
  method: "GET" | "POST";
  /** Form params for the request body (POST) — flat; see toFormBody. */
  body?: Record<string, string | number | boolean | null | undefined>;
  /** Pass-through for the Idempotency-Key header (safe retries). */
  idempotencyKey?: string;
};

/**
 * Make ONE request to the Stripe API at https://api.stripe.com/v1${path}.
 *
 * Auth: HTTP Basic with the secret key as the USERNAME and an EMPTY password,
 * i.e. `Authorization: Basic base64(`${secretKey}:`)` — Stripe's standard
 * scheme. The body is form-encoded (application/x-www-form-urlencoded) for POST.
 * An optional Idempotency-Key header is passed through. There is NO
 * Stripe-Account header — this platform uses a SINGLE Stripe account.
 *
 * THROWS a typed StripeError on any non-2xx, carrying Stripe's
 * error.type / error.code / error.message parsed from the JSON error body.
 *
 * THROWS (StripeError) BEFORE making any network call if `stripeConfig()` is
 * null — a caller can never accidentally hit Stripe while unconfigured, which
 * is what keeps this module DORMANT-safe.
 */
export async function stripeRequest(
  path: string,
  options: StripeRequestOptions,
): Promise<unknown> {
  const config = stripeConfig();
  if (!config) {
    // Guard: refuse to touch the network while Stripe is unconfigured.
    throw new StripeError(
      null,
      null,
      null,
      "Stripe is not configured (STRIPE_SECRET_KEY unset) — refusing to call the Stripe API",
    );
  }

  const { method, body, idempotencyKey } = options;

  // Basic auth: secret key as username, EMPTY password → base64(`${key}:`).
  const auth = Buffer.from(`${config.secretKey}:`, "utf8").toString("base64");

  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers,
    body: method === "POST" && body ? toFormBody(body) : undefined,
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Stripe always returns JSON; a parse failure on a non-2xx still surfaces
    // below as a StripeError.
  }

  if (!res.ok) {
    const error = (json as { error?: { type?: string; code?: string; message?: string } } | null)
      ?.error;
    throw new StripeError(
      res.status,
      typeof error?.type === "string" ? error.type : null,
      typeof error?.code === "string" ? error.code : null,
      error?.message ?? `Stripe responded ${res.status}`,
    );
  }

  return json;
}

/**
 * Connectivity smoke-test helper: GET /account. Returns the account object on
 * success, throws StripeError otherwise (or if Stripe is unconfigured).
 */
export async function stripeGetAccount(): Promise<unknown> {
  return stripeRequest("/account", { method: "GET" });
}

// ---------------------------------------------------------------------------
// Customer creation (single account — no Stripe-Account header).
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Customer on the platform account. We pass the guardian's
 * email/name (best-effort, both optional) and a metadata.guardianId so the
 * Customer is traceable back to our row. Returns just the new customer `id`
 * ("cus_..."), which we persist on travelGuardians.stripeCustomerId.
 */
export async function createStripeCustomer(params: {
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}): Promise<{ id: string }> {
  const body: Record<string, string | number | boolean | null | undefined> = {
    email: params.email ?? undefined,
    name: params.name ?? undefined,
  };
  for (const [k, v] of Object.entries(params.metadata ?? {})) {
    body[`metadata[${k}]`] = v;
  }
  const json = (await stripeRequest("/customers", {
    method: "POST",
    body,
  })) as { id?: unknown };
  if (typeof json.id !== "string") {
    throw new StripeError(null, null, null, "Stripe /customers returned no id");
  }
  return { id: json.id };
}

// ---------------------------------------------------------------------------
// Deposit-prime checkout (mode=payment) — captures the deposit now. SINGLE
// account (no Stripe-Account header). The invoice balance is NOT touched here —
// that happens ONLY in the signature-verified payment_intent.succeeded webhook,
// keyed on the PaymentIntent id so it can never double-apply.
// ---------------------------------------------------------------------------

/**
 * Create a hosted Checkout Session in `mode=payment` for the given Customer —
 * the deposit-prime capture. A single line item (price_data, so we never need a
 * pre-created Product/Price) charges `amountCents` now. CARD-ONLY collection.
 *
 * Each metadata entry is attached to the PaymentIntent (the object the webhook
 * reads back) via `payment_intent_data[metadata][<k>]` — so our invoiceId /
 * guardianId / kind ride through to the PI.
 *
 * NOTE (4b-2): we deliberately do NOT set `setup_future_usage` here — vaulting
 * the card for off-session installments lands in a later task.
 *
 * Returns the session `id` + the hosted `url` to redirect the browser to; THROWS
 * StripeError if Stripe returns no id/url.
 */
export async function createPaymentCheckoutSession(params: {
  customerId: string;
  amountCents: number;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<{ id: string; url: string }> {
  // Live-gate: refuse a live charge unless STRIPE_LIVE_OK is set.
  assertChargeAllowed();
  const body: Record<string, string | number | boolean | null | undefined> = {
    mode: "payment",
    customer: params.customerId,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // FORCE CARD-ONLY collection.
    "payment_method_types[0]": "card",
    // Single line item via price_data — no pre-created Product/Price needed.
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": params.amountCents,
    "line_items[0][price_data][product_data][name]": params.productName,
    "line_items[0][quantity]": 1,
  };
  // Metadata on the PaymentIntent (the object payment_intent.succeeded reads).
  for (const [k, v] of Object.entries(params.metadata)) {
    body[`payment_intent_data[metadata][${k}]`] = v;
  }
  const json = (await stripeRequest("/checkout/sessions", {
    method: "POST",
    body,
  })) as { id?: unknown; url?: unknown };
  if (typeof json.id !== "string" || typeof json.url !== "string") {
    throw new StripeError(
      null,
      null,
      null,
      "Stripe /checkout/sessions (payment) returned no id/url",
    );
  }
  return { id: json.id, url: json.url };
}

// ---------------------------------------------------------------------------
// Card-on-file (SetupIntent) vault — Block 4b-2. Save a card for future off-
// session charges. SINGLE account (no Stripe-Account header). Saving a card
// moves NO money, so these helpers do NOT call assertChargeAllowed() — only
// actual charges (createPaymentCheckoutSession / createRefund) pass the live
// gate. The off-session charging half lands in a later task.
// ---------------------------------------------------------------------------

/**
 * Create a hosted Checkout Session in `mode=setup` for the given Customer — the
 * card-on-file vault flow. Collects & saves a CARD (no charge) so it can be used
 * for future off-session charges. NO line items / amount (nothing is captured).
 *
 * Each metadata entry is attached to the SetupIntent (the object the webhook
 * reads back) via `setup_intent_data[metadata][<k>]` — so our guardianId rides
 * through to the SetupIntent that setup_intent.succeeded delivers.
 *
 * NOTE: no assertChargeAllowed() here — saving a card moves NO money, so this
 * path is not gated by the pre-live live-charge switch.
 *
 * Returns the session `id` + the hosted `url` to redirect the browser to; THROWS
 * StripeError if Stripe returns no id/url.
 */
export async function createSetupCheckoutSession(params: {
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<{ id: string; url: string }> {
  const body: Record<string, string | number | boolean | null | undefined> = {
    mode: "setup",
    customer: params.customerId,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    // FORCE CARD-ONLY collection.
    "payment_method_types[0]": "card",
  };
  // Metadata on the SetupIntent (the object setup_intent.succeeded reads).
  for (const [k, v] of Object.entries(params.metadata)) {
    body[`setup_intent_data[metadata][${k}]`] = v;
  }
  const json = (await stripeRequest("/checkout/sessions", {
    method: "POST",
    body,
  })) as { id?: unknown; url?: unknown };
  if (typeof json.id !== "string" || typeof json.url !== "string") {
    throw new StripeError(
      null,
      null,
      null,
      "Stripe /checkout/sessions (setup) returned no id/url",
    );
  }
  return { id: json.id, url: json.url };
}

/**
 * Retrieve a saved PaymentMethod for its display fields. `type` maps to our
 * `kind` (e.g. "card"); the card sub-object's brand/last4/exp_month/exp_year are
 * all read defensively (any may be absent → null). THROWS StripeError if Stripe
 * returns no id.
 */
export async function retrieveStripePaymentMethod(
  paymentMethodId: string,
): Promise<{
  id: string;
  kind: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}> {
  const json = (await stripeRequest(`/payment_methods/${paymentMethodId}`, {
    method: "GET",
  })) as {
    id?: unknown;
    type?: unknown;
    card?: {
      brand?: unknown;
      last4?: unknown;
      exp_month?: unknown;
      exp_year?: unknown;
    } | null;
  };
  if (typeof json.id !== "string") {
    throw new StripeError(
      null,
      null,
      null,
      "Stripe /payment_methods returned no id",
    );
  }
  const card = json.card ?? null;
  return {
    id: json.id,
    kind: typeof json.type === "string" ? json.type : "card",
    brand: typeof card?.brand === "string" ? card.brand : null,
    last4: typeof card?.last4 === "string" ? card.last4 : null,
    expMonth: typeof card?.exp_month === "number" ? card.exp_month : null,
    expYear: typeof card?.exp_year === "number" ? card.exp_year : null,
  };
}

/**
 * Retrieve a SetupIntent — the FALLBACK when a webhook payload is thin (missing
 * the payment_method id or our guardianId metadata). `payment_method` and
 * `customer` may EACH be a bare id string OR an expanded object `{ id }` — we
 * accept both (prefer the string form, else read `.id`). Metadata values are
 * coerced to strings. THROWS StripeError if Stripe returns no id.
 */
export async function retrieveStripeSetupIntent(
  setupIntentId: string,
): Promise<{
  id: string;
  paymentMethodId: string | null;
  customerId: string | null;
  metadata: Record<string, string>;
}> {
  const json = (await stripeRequest(`/setup_intents/${setupIntentId}`, {
    method: "GET",
  })) as {
    id?: unknown;
    payment_method?: unknown;
    customer?: unknown;
    metadata?: Record<string, unknown> | null;
  };
  if (typeof json.id !== "string") {
    throw new StripeError(
      null,
      null,
      null,
      "Stripe /setup_intents returned no id",
    );
  }
  // Accept a bare id string OR an expanded { id } object for each ref.
  const readRefId = (ref: unknown): string | null => {
    if (typeof ref === "string") return ref;
    if (ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string") {
      return (ref as { id: string }).id;
    }
    return null;
  };
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(json.metadata ?? {})) {
    metadata[k] = String(v);
  }
  return {
    id: json.id,
    paymentMethodId: readRefId(json.payment_method),
    customerId: readRefId(json.customer),
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Refunds (single account — no Stripe-Account header).
// ---------------------------------------------------------------------------

/**
 * Refund (part of) a captured charge. `chargeId` is the Charge id ("ch_...")
 * stored on our payment row; `amountCents` is the partial amount (omit for a
 * full refund — but we always pass an explicit amount). Pass an `idempotencyKey`
 * so a retried refund request never double-refunds. Returns the Refund id +
 * status; THROWS StripeError on any failure (e.g. a charge already fully
 * refunded → the caller surfaces it).
 */
export async function createRefund(
  params: { chargeId: string; amountCents: number; reason?: string },
  idempotencyKey: string,
): Promise<{ id: string; status: string | null }> {
  // Live-gate: refuse a live charge unless STRIPE_LIVE_OK is set.
  assertChargeAllowed();
  const body: Record<string, string | number | boolean | null | undefined> = {
    charge: params.chargeId,
    amount: params.amountCents,
  };
  const json = (await stripeRequest("/refunds", {
    method: "POST",
    body,
    idempotencyKey,
  })) as { id?: unknown; status?: unknown };
  if (typeof json.id !== "string") {
    throw new StripeError(null, null, null, "Stripe /refunds returned no id");
  }
  return {
    id: json.id,
    status: typeof json.status === "string" ? json.status : null,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Node `crypto` only — no `stripe` npm dep).
//
// THE SECURITY MODEL: the route never trusts the request body. It computes the
// expected signature = HMAC-SHA256(`${t}.${rawBody}`, secret) as HEX, where
// `secret` is the "whsec_..." endpoint secret only WE and Stripe hold, and
// accepts the request iff a header signature matches in constant time AND the
// timestamp is fresh (±5 min replay window). An attacker who can POST but lacks
// the secret cannot forge a matching signature.
//
// Stripe uses the endpoint secret STRING DIRECTLY as the UTF-8 HMAC key (it does
// NOT base64-decode the "whsec_..." secret); the signed payload is
// `${timestamp}.${rawBody}`; the expected signature is HEX; the Stripe-Signature
// header is COMMA-separated `k=v` pairs (t=..., v1=...). NEVER throws — any
// malformed/missing input returns false.
// ---------------------------------------------------------------------------

// Replay-protection window: reject signatures whose timestamp is more than this
// many seconds away from now (past OR future). Stripe's documented default.
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifyStripeWebhookArgs = {
  /** The Stripe endpoint signing secret, e.g. "whsec_...". Used DIRECTLY. */
  secret: string;
  /** The raw `Stripe-Signature` header value (comma-separated k=v pairs). */
  signatureHeader: string;
  /** The EXACT raw request body (req.text()), not re-serialized JSON. */
  rawBody: string;
  /** Override the ±replay tolerance in seconds (default 300). */
  toleranceSec?: number;
};

/** Constant-time equality of two HEX signature strings (length-guarded). */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Parse a Stripe-Signature header into its timestamp + all v1 signatures.
 *   Header form: "t=1492774577,v1=5257a8...,v1=anotherone,v0=legacy"
 * Returns null if `t` is missing or there are no `v1` entries.
 */
function parseSignatureHeader(
  header: string,
): { t: string; v1: string[] } | null {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value.length === 0) continue;
    if (key === "t") t = value;
    else if (key === "v1") v1.push(value);
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Verify a Stripe-signed webhook. Returns true iff:
 *   - all inputs are present and well-formed,
 *   - the timestamp `t` is within ±toleranceSec of now (replay protection),
 *   - and SOME `v1` value equals the expected signature in constant time.
 *
 * Signed payload = `${t}.${rawBody}`.
 * Expected sig   = HEX(HMAC-SHA256(signedPayload, secret-as-utf8-bytes)).
 *
 * NEVER throws.
 */
export function verifyStripeWebhook(args: VerifyStripeWebhookArgs): boolean {
  const { secret, signatureHeader, rawBody, toleranceSec } =
    args ?? ({} as VerifyStripeWebhookArgs);

  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    typeof signatureHeader !== "string" ||
    signatureHeader.length === 0 ||
    typeof rawBody !== "string"
  ) {
    return false;
  }

  const tolerance =
    typeof toleranceSec === "number" && Number.isFinite(toleranceSec)
      ? toleranceSec
      : DEFAULT_TOLERANCE_SECONDS;

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  // Replay protection: timestamp is unix SECONDS. Reject if non-numeric or
  // outside the tolerance window (in either direction).
  const ts = Number(parsed.t);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return false;

  // Stripe uses the secret STRING DIRECTLY as the UTF-8 HMAC key.
  const signedPayload = `${parsed.t}.${rawBody}`;
  let expected: string;
  try {
    expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
  } catch {
    return false;
  }

  // Accept iff ANY v1 signature matches. Do not early-return on first match so
  // total work is not a function of WHICH signature matched (defense-in-depth).
  let matched = false;
  for (const sig of parsed.v1) {
    if (timingSafeEqualHex(sig, expected)) matched = true;
  }
  return matched;
}
