// Fire-and-forget liveness ping to a Better Stack heartbeat URL, fired by the
// cron handlers ONLY after their work completes successfully. Best-effort and
// inert by contract: never throws, never changes the caller's response, and is
// a no-op when `url` is absent (so dev/preview/test, where the HEARTBEAT_URL_*
// env vars are unset, do nothing).
//
// We AWAIT the ping (with a short timeout) rather than truly detaching it:
// on Vercel serverless a fetch left running after the response returns can be
// frozen/killed before it lands — which would itself fail silently and defeat
// the whole point. Awaiting a ~3s-bounded best-effort GET guarantees the
// liveness signal reaches Better Stack while still never affecting the cron's
// own status/body (all errors, including the timeout abort, are swallowed).
export async function pingHeartbeat(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Swallow everything — network error, DNS, timeout abort. A failed
    // heartbeat must never break or alter a successful cron run.
  }
}
