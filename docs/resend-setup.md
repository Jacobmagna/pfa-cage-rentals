# Resend (email magic-link) setup

Why: `pfasports.com` is not on Google Workspace, so Dad and Mom can't sign in with Google. Resend sends them a one-time sign-in link instead. Also covers any future coach without a Gmail.

You'll end with one value in `.env.local`:

```
AUTH_RESEND_KEY="re_<...>"
```

## Step 1 — get the API key

1. https://resend.com → sign in.
2. Left nav → **API Keys** → **Create API Key**.
3. Name: `pfa-cage-rentals-local` · Permission: **Sending access** · Domain: **All domains** · **Add**.
4. Copy the `re_...` value (only shown once).
5. Paste into `.env.local` as `AUTH_RESEND_KEY`.

## Step 2 — verify Dad's and Mom's emails for sandbox testing

Because we haven't bought `pfacagerentals.com` yet, we send from Resend's shared `onboarding@resend.dev` sender. **In sandbox mode, that sender can only deliver to emails you've verified in your Resend account.**

For each recipient you want to test with (Dad, Mom, any coach):

1. Resend dashboard → **Domains** is not the path — instead go to **Settings → Team** or top-right account menu → look for **Verified Emails** / **Add test recipient**.
   - If the UI has changed, the equivalent: Resend → **API logs / Emails** → try sending; if blocked, it'll prompt you to verify the recipient.
2. Add `mdm@pfasports.com` and `esther@pfasports.com`. Each address gets a one-click verification email — forward to Dad/Mom to click.

(Your own email — whichever you use for the Resend account — is auto-verified, so you can test with it immediately without this step.)

## Step 3 — buy the domain (Phase 9, not now)

Once `pfacagerentals.com` is bought via Vercel:

1. Resend → **Domains** → **Add Domain** → `pfacagerentals.com` → follow the DNS prompts (Vercel DNS makes this 2 clicks).
2. Once verified, in `src/auth.ts` change `from: "PFA Cage Rentals <onboarding@resend.dev>"` → `from: "PFA Cage Rentals <noreply@pfacagerentals.com>"`.
3. The sandbox recipient verification (Step 2) becomes unnecessary — you can send to any address.

## Step 4 — sanity test

After Step 1 (and Step 2 if testing with Dad/Mom):

```
npm run dev
```

1. http://localhost:3000
2. Enter `mdm@pfasports.com` in the email field → **Email me a sign-in link**.
3. Page redirects to "Check your email" (Auth.js default verify-request page).
4. Email arrives in Dad's inbox (subject: "Sign in to localhost:3000") → click link → land on `/admin`.

If the email doesn't arrive:
- Spam folder first.
- Resend dashboard → **Emails** tab shows every send + delivery status. If it says `bounced` or `not allowed`, recipient isn't verified (Step 2).
- If it says `delivered` but no email visible, check Dad's spam / quarantine.
