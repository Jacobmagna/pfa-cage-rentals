# Travel slice — integration base (routing + auth + coordination)

**Owner of this base + `main` + all shared facility files: the facility maintenance chat.**
This document is the contract the travel build (`travel.pfaengine.com`) builds on top of. It is committed on the long-lived `travel` branch and reaches prod only at a coordinated `travel → main` drop, gated by facility maintenance.

Everything here is **additive**. The facility app (`pfaengine.com` / `www` / `pfacagerentals.com`) is byte-identical with or without the travel slice, until `TRAVEL_ENABLED=true`.

---

## 1. Host routing — `src/proxy.ts` (pre-staged base)

- **Facility hosts → `NextResponse.next()`, unconditionally.** No rewrite/redirect/header change.
- **`travel.pfaengine.com`, `TRAVEL_ENABLED` unset → 404** (travel host never leaks facility UI while dark).
- **`travel.pfaengine.com`, `TRAVEL_ENABLED=true` → rewrite into the `/travel` route group.** This is the branch the travel build wires up: put all travel pages/routes under `src/app/travel/**`. The middleware rewrites `travel.pfaengine.com/x` → internal `/travel/x` with the URL unchanged.
- Middleware **fails open** to facility passthrough on any error — it can never 500 the live facility site.
- Auth is intentionally NOT in the middleware (see §2).

**Travel build TODO:** create `src/app/travel/**` (its own `layout.tsx`, routes, `not-found`), then flip `TRAVEL_ENABLED=true` in the travel dev env to exercise the rewrite. Do NOT rewrite before those routes exist (would 404).

## 2. Auth — travel gets its OWN cookie/login (decided)

**The facility `src/auth.ts` is NOT modified.** No cross-subdomain cookie, no `.pfaengine.com` domain scoping — that removes the entire live-logout risk for the ~49 active facility users. Rationale: only ~4 facility admins ever touch both apps, and a second login for them is trivial; the facility-side "Travel" tab reads travel DATA inside the existing facility session (a DB read, not a travel login), so no SSO is needed anywhere.

**Travel stands up a SEPARATE Auth.js (NextAuth v5) instance** — e.g. `src/travel/auth.ts` — with:

- **A distinct cookie name** so the two sessions can never collide, even though the hosts already differ:
  ```ts
  // src/travel/auth.ts (travel build owns this file)
  export const { handlers, auth, signIn, signOut } = NextAuth({
    adapter: DrizzleAdapter(db, {
      usersTable: users,          // SHARED users/accounts (one family record)
      accountsTable: accounts,
      sessionsTable: travelSessions,   // travel's OWN session table (additive)
      verificationTokensTable: verificationTokens,
    }),
    session: { strategy: "database" },
    cookies: {
      sessionToken: {
        // prod: "__Secure-" prefix + secure. Distinct from facility's
        // "authjs.session-token" so a browser holding both never confuses them.
        name: "__Secure-travel-authjs.session-token",
        options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
        // NO `domain` → host-only, scoped to travel.pfaengine.com only.
      },
    },
    // ...providers (magic link), callbacks (stamp travel_admin role/guard)
  });
  ```
- **Shared `users` + `accounts` tables** (a family = one record across both slices — the whole reason for one DB). **Travel's own `travel_sessions` table** (additive, travel migration) so the two auth systems are fully independent at the storage layer and neither can read the other's sessions. `AUTH_URL` for travel = `https://travel.pfaengine.com`.
- **Its own guard** — `requireTravelAccess()` in a travel authz module (mirror `src/lib/authz.ts`), passing `role === "admin" || role === "travel_admin"`. Facility guards are untouched and continue to exclude travel-only users (they aren't `coach`/`admin` on the facility side).

**Role:** `role` is a Postgres enum (`["coach","admin"]`). Adding `travel_admin` means altering that enum — the exact enum migration we avoid on the shared DB. Options for Jacob to pick (flagged, not decided): (a) one careful `ALTER TYPE role ADD VALUE 'travel_admin'` migration, or (b) an additive `travel_admin boolean` flag on `users` (no enum change) + `requireTravelAccess()` keying off it. **(b) keeps the no-enum-alter rule** and is the safer default; confirm before building the role.

## 3. `next.config.ts` — `allowedOrigins` (pre-staged)

`travel.pfaengine.com` added to `serverActions.allowedOrigins` (else travel server actions 403). Additive; no facility effect.

## 4. pfacagerentals.com auth — confirmed safe

Confirmed: **nobody holds an authenticated session on `pfacagerentals.com`.** There's no next.config redirect, but Auth.js builds every magic-link callback from `AUTH_URL` (= `www.pfaengine.com`), so login always completes and sets its host-only cookie on `www.pfaengine.com` regardless of entry host. Travel's host-only cookie on `travel.pfaengine.com` is fully independent — no conflict.

## 5. Migrations — start at 0044, regenerate, serialize

This repo's prod is at **`0043`**. `0037–0043` are FACILITY migrations (different content from Northstar's 0037+). **Do NOT port Northstar's raw SQL.** Port the travel *table definitions* into `schema.ts`, then `drizzle-kit generate` against THIS repo to produce fresh CREATE-only migrations starting at **`0044`**, proven on the `travel-dev` Neon branch first. **Ping facility maintenance for the next free migration number every time** so two chats never grab the same one.

## 6. Deploy coordination (locked)

- Long-lived `travel` off `main`; short branches off `travel`; rebase `travel` from `main` before every migration and before every merge back.
- `travel → main` only in coordinated drops that facility maintenance approves/merges. Per-drop gate: green facility gates (`typecheck`/`lint`/`test`/`build`) + migration number cleared + facility maintenance watching `/api/health` after deploy.
- Every `travel → main` merge is a full-app prod deploy (auto-migrate + rebuild of BOTH slices). Nothing merges with an untested migration or red gates.
- `TRAVEL_ENABLED` stays OFF in prod until go-live.
- Stripe: fresh account, TEST mode to build; live-account ownership goes to the company chat before any live keys; travel Stripe keys live in travel's env only, never facility env, never the repo.
