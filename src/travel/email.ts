// Travel parent-facing transactional email (claim / password-reset links).
// A thin Resend REST client using plain `fetch` — NO `resend` npm dep, mirroring
// how Northstar's src/lib/email/client.ts talks to Resend. Every send goes out
// as the shared verified pfaengine.com sender; a parent-facing sender rebrand is
// a later block, so we keep "PFA Engine <noreply@pfaengine.com>" for now.
//
// On a successful send Resend returns a 2xx with the created email id; we don't
// need it (no delivery webhook here), so any 2xx is treated as accepted. A
// non-2xx is captured to Sentry (mirroring how src/travel/auth.ts captures) and
// re-thrown as a GENERIC Error so the caller's failure copy never leaks the
// provider status.
//
// server-only: it sends mail with the Resend secret key.

import "server-only";
import * as Sentry from "@sentry/nextjs";

// The shared verified sender on the pfaengine.com Resend domain. (Parent-facing
// sender rebrand is a later block — keep "PFA Engine" for now.)
const TRAVEL_EMAIL_FROM = "PFA Engine <noreply@pfaengine.com>";

/** HTML-escape user-supplied values before interpolation into an email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send one transactional email via the Resend REST API. POSTs to
 * https://api.resend.com/emails with `Authorization: Bearer <AUTH_RESEND_KEY>`
 * and a JSON `{ from, to, subject, html }` body. Any non-2xx is captured to
 * Sentry and re-thrown as a generic Error (the HTTP status never reaches the
 * caller/UI).
 */
export async function sendTravelEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: TRAVEL_EMAIL_FROM,
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    let detail = `Resend responded ${res.status}`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json?.message) detail = json.message;
    } catch {
      // Resend returns JSON on error; a parse failure still leaves the status.
    }
    Sentry.captureException(
      new Error(`Travel email send failed (${res.status}): ${detail}`),
    );
    throw new Error("Failed to send email.");
  }
}

/**
 * Shared branded card shell for the two travel emails. Dark header band with the
 * PFA yellow wordmark, a friendly heading + intro, and a single yellow CTA
 * button linking to `link`. `link` is app-generated (origin + a fixed path +
 * query) but escaped defensively all the same.
 */
function renderTravelEmailHtml({
  heading,
  intro,
  ctaLabel,
  link,
  footer,
}: {
  heading: string;
  intro: string;
  ctaLabel: string;
  link: string;
  footer: string;
}): string {
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#0a0a0a;padding:16px 24px;">
                <span style="display:inline-block;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#FFC400;">PFA Engine</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;color:#27272a;font-size:15px;line-height:1.6;">
                <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:700;color:#0a0a0a;">${escapeHtml(heading)}</h1>
                <p style="margin:0 0 24px;">${escapeHtml(intro)}</p>
                <p style="margin:0 0 24px;"><a href="${safeLink}" style="display:inline-block;background:#FFC400;color:#0a0a0a;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:6px;">${escapeHtml(ctaLabel)}</a></p>
                <p style="margin:0;color:#71717a;font-size:13px;">${escapeHtml(footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Email a parent the link to CLAIM their travel account (set a password + verify
 * their email). The raw token rides in the URL; the DB stores only its hash.
 */
export async function sendClaimEmail(
  email: string,
  rawToken: string,
  origin: string,
): Promise<void> {
  const link = `${origin}/travel/claim?email=${encodeURIComponent(
    email,
  )}&token=${rawToken}`;
  await sendTravelEmail({
    to: email,
    subject: "Set up your PFA Travel account",
    html: renderTravelEmailHtml({
      heading: "Set up your PFA Travel account",
      intro:
        "PFA Travel started an account for your family. Click below to set your password and finish setting up your parent account. This link expires in 24 hours and can only be used once.",
      ctaLabel: "Set up my account",
      link,
      footer:
        "If you weren't expecting this, you can safely ignore this email.",
    }),
  });
}

/**
 * Email a parent the link to RESET their travel account password. The raw token
 * rides in the URL; the DB stores only its hash.
 */
export async function sendResetEmail(
  email: string,
  rawToken: string,
  origin: string,
): Promise<void> {
  const link = `${origin}/travel/reset?email=${encodeURIComponent(
    email,
  )}&token=${rawToken}`;
  await sendTravelEmail({
    to: email,
    subject: "Reset your PFA Travel password",
    html: renderTravelEmailHtml({
      heading: "Reset your PFA Travel password",
      intro:
        "We received a request to reset your PFA Travel password. Click below to choose a new one. This link expires in 1 hour and can only be used once.",
      ctaLabel: "Reset my password",
      link,
      footer:
        "If you didn't request this, you can safely ignore this email — your password won't change.",
    }),
  });
}
