# Google OAuth setup

One-time setup to create a Google Cloud project + OAuth credentials so coaches can sign in with Google.

You'll end with two values to paste into `.env.local`:

```
AUTH_GOOGLE_ID="<...apps.googleusercontent.com>"
AUTH_GOOGLE_SECRET="GOCSPX-<...>"
```

Estimated time: ~10 min.

---

## Step 1 — create a Google Cloud project

1. Open https://console.cloud.google.com/ (sign in as `mdm@pfasports.com` — Dad should own the project so it lives under his account).
2. Top bar → project selector (left of search) → **New Project**.
3. Name: `PFA Cage Rentals`. Organization: leave default. Click **Create**.
4. Wait ~10s for it to provision, then make sure the new project is selected in the top bar.

## Step 2 — configure the OAuth consent screen

1. Left nav → **APIs & Services** → **OAuth consent screen**.
2. **User Type:** **External** → Create.
3. Fill in:
   - **App name:** `PFA Cage Rentals`
   - **User support email:** `mdm@pfasports.com`
   - **App logo:** skip
   - **Application home page:** `https://pfacagerentals.com` (placeholder — fine even before the domain is live)
   - **Authorized domains:** `pfacagerentals.com` (skip if Google won't accept it pre-launch; we'll add it later)
   - **Developer contact email:** `mdm@pfasports.com`
4. **Save and continue.**
5. **Scopes** screen → click **Add or Remove Scopes** → check **`.../auth/userinfo.email`**, **`.../auth/userinfo.profile`**, and **`openid`** → **Update** → **Save and continue**.
6. **Test users** screen → **+ Add users** → add:
   - `jacob@themagnas.com`
   - `mdm@pfasports.com`
   - `esther@pfasports.com`
   - (any coach emails you want to test with during development)
   → **Save and continue**.
7. **Summary** → **Back to dashboard**.

The app stays in **Testing** mode until launch — that's fine. Only listed test users can sign in. Push to **Production** later (one-click; may require a domain-verification check).

## Step 3 — create OAuth client credentials

1. Left nav → **APIs & Services** → **Credentials**.
2. **+ Create Credentials** → **OAuth client ID**.
3. **Application type:** **Web application**.
4. **Name:** `PFA Cage Rentals — Local + Vercel`.
5. **Authorized JavaScript origins:**
   - `http://localhost:3000`
   - `https://pfacagerentals.com` (add now or after domain is live)
   - `https://<your-vercel-preview>.vercel.app` (add the actual preview URL once we deploy)
6. **Authorized redirect URIs:**
   - `http://localhost:3000/api/auth/callback/google`
   - `https://pfacagerentals.com/api/auth/callback/google` (after domain is live)
   - `https://<your-vercel-preview>.vercel.app/api/auth/callback/google` (after deploy)
7. **Create.** A modal pops up with **Client ID** and **Client secret**.
8. Copy both values now (you can also re-download them anytime from the credentials page).

## Step 4 — paste into `.env.local`

Open `/Users/jacobmagna/coaches-cage-ai/.env.local` and fill in:

```
AUTH_GOOGLE_ID="<client id from step 3>"
AUTH_GOOGLE_SECRET="<client secret from step 3>"
```

Save the file. No restart needed for `.env.local` changes between requests, but if `npm run dev` was already running, restart it so the env reloads.

## Step 5 — sanity test

```
npm run dev
```

1. Open http://localhost:3000.
2. Click **Sign in with Google**.
3. Sign in with `mdm@pfasports.com` (the 60-sec Workspace sanity test from BRAINSTORM.md).
4. You should land on `/admin`.
5. Sign out, then sign in with any non-admin test user — should land on `/coach`.

If sign-in with Dad's account fails:
- Most likely cause: `pfasports.com` is **not** on Google Workspace. The fallback in BRAINSTORM.md is email magic-link via Auth.js (~20 min swap — Resend or SMTP provider).
- Less common: the test user wasn't added to the consent screen. Re-check Step 2.6.

## Later — production checklist

Before launch (Phase 9):
- Add the real production callback URI (custom domain) to the OAuth client.
- Push the consent screen from **Testing** to **Production** (may require domain ownership verification via Search Console).
- Add the same `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (+ `AUTH_SECRET`, `DATABASE_URL`) to Vercel project env vars.
- Set `AUTH_TRUST_HOST=true` in Vercel env if Auth.js doesn't auto-detect host.
