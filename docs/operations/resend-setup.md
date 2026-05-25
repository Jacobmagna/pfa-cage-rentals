# Resend (email magic-link) setup

Why: `pfasports.com` is not on Google Workspace, so Dad and Mom can't sign in with Google. Resend sends them a one-time sign-in link instead. Also covers any future coach without a Gmail.

**Account separation:** PFA has its own Resend account (`jacob+pfa@themagnas.com`), separate from the doc-insured Resend account. Same pattern as the dedicated PFA Upstash account. Reason: Resend's free tier allows one verified domain per account; doc-insured already uses that slot.

You'll end with one value in `.env.local`:

```
AUTH_RESEND_KEY="re_<...>"
```

## Step 1 — create the PFA Resend account

1. Open https://resend.com in an incognito window (so you don't accidentally land on the doc-insured account).
2. Sign up with `jacob+pfa@themagnas.com` (Gmail's `+tag` lets it route to your regular inbox while staying a distinct address for Resend).
3. Verify the signup link in email.

## Step 2 — verify pfacagerentals.com

1. Resend dashboard → **Domains** → **Add Domain** → `pfacagerentals.com`.
2. Resend shows ~4 DNS records to add (SPF TXT, DKIM CNAMEs, MAIL FROM TXT). Copy each.
3. Open GoDaddy (https://dcc.godaddy.com/manage/pfacagerentals.com/dns) and add each record exactly as Resend shows it. Host fields are usually `@`, `resend._domainkey`, etc — paste verbatim from Resend, don't append the domain.
4. Back in Resend → **Verify**. DNS propagation is typically 5–15 min on GoDaddy; refresh until all rows go green.

## Step 3 — generate API key

1. Resend dashboard → **API Keys** → **Create API Key**.
2. Name: `pfa-cage-rentals` · Permission: **Sending access** · Domain: **pfacagerentals.com**.
3. Copy the `re_...` value (only shown once).
4. Paste into `.env.local` as `AUTH_RESEND_KEY`.

## Step 4 — paste into Vercel

1. Vercel → Project → Settings → Environment Variables.
2. Find existing `AUTH_RESEND_KEY` (it currently holds the doc-insured key). **Update value** to the new key from Step 3. Apply to Production, Preview, and Development.
3. Trigger a redeploy (push a no-op commit or use Vercel UI → Redeploy).

## Step 5 — sanity test

After Step 3 (locally) and Step 4 (in prod):

```
npm run dev
```

1. http://localhost:3000
2. Enter `mdm@pfasports.com` → **Email me a sign-in link**.
3. Page redirects to "Check your email".
4. Email arrives in Dad's inbox from `noreply@pfacagerentals.com` (subject: "Sign in to localhost:3000") → click link → land on `/admin`.

Repeat against `https://pfacagerentals.com` after the Vercel redeploy to verify the prod env var.

If the email doesn't arrive:
- Spam folder first.
- Resend dashboard → **Emails** tab shows every send + delivery status. If it says `bounced`, check the recipient address. If `not allowed`, the domain isn't fully verified yet (Step 2).
- If `delivered` but no email visible, check the recipient's quarantine.

## Step 6 — rotate doc-insured key (cleanup)

Once the new key is verified working in prod, the old doc-insured key is no longer used by this project. Optional but tidy:
- doc-insured Resend → revoke the old `pfa-cage-rentals-local` API key (if it was issued from that account).
- Update `pfa@docinsured.com` mailbox (if you set one up) to bounce — no project should be sending from it anymore.

## Related deliverability work

- **J2** (SPF + DMARC on `pfacagerentals.com`): the SPF Resend asks you to add in Step 2 covers `include:_spf.resend.com`. DMARC is separate and lives in J2 of the production checklist.
- **J3** (mail-tester.com score): after Steps 1–5, send a magic link to a mail-tester address to verify deliverability. Target ≥ 9/10.
