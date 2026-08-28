"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Mark's answer to "if the internet drops, blank or keep showing?" was BLANK,
// and his reasoning is the whole spec for this file:
//
//   "blank is less worrying than something showing the wrong time and going
//    unnoticed -- even with a stamp."
//
// 🔴 GOING BLANK IS NOT FREE, AND THAT IS THE ENTIRE REASON THIS COMPONENT
// EXISTS. A page whose network dies does not blank itself. It keeps showing
// its last good render indefinitely, looking perfectly healthy, because
// `AutoRefresh`'s router.refresh() fails SILENTLY -- it returns void and
// there is nothing to catch. A wall screen confidently displaying a
// three-hour-old schedule is the exact failure Mark described.
//
// 🔴 HOW STALENESS IS MEASURED, AND WHY NOT THE OBVIOUS WAY. The obvious
// implementation compares the server's `renderedAt` to the client's
// Date.now(). DO NOT DO THAT. It compares TWO DIFFERENT CLOCKS, and the
// client here is a cheap TV browser whose clock may be minutes or hours off
// -- which yields either a permanently blank screen or one that never blanks
// at all, and both fail silently. This repo has been bitten three times by
// naive-timestamp round trips already (discipline rule 22).
//
// Instead: the client only ever measures ITS OWN elapsed time since it last
// saw `renderedAt` CHANGE. Two readings of one monotonic clock. It never
// needs the two machines to agree, and it is correct even if the TV thinks
// it is 1970.
//
// performance.now() rather than Date.now() for the same reason at a smaller
// scale: it is monotonic, so an NTP correction mid-afternoon cannot make the
// screen blank or un-blank on its own.

/**
 * How long without a fresh server render before the screen is presumed dead.
 *
 * AutoRefresh polls every 30s, so this is three missed cycles. Tighter than
 * that and an ordinary hiccup blanks the wall; looser and a genuinely dead
 * display keeps lying for minutes.
 */
export const STALE_AFTER_MS = 100_000;

/** How often to re-check. Cheap; the whole check is one subtraction. */
const CHECK_INTERVAL_MS = 5_000;

/**
 * The whole decision, as a pure function, so the single most important safety
 * behaviour in this feature is PROVABLE rather than asserted.
 *
 * 🔴 THIS WAS EXTRACTED FOR A CONCRETE REASON. Verifying "the screen blanks
 * when the connection dies" end to end means killing a server and waiting out
 * a 100-second timer against a real browser — which is slow, and which
 * nobody will ever re-run when they change this file. Left inline, the rule
 * that decides whether a wall screen lies to the facility would have been
 * covered by nothing at all.
 *
 * `msSinceLastFresh` is a MONOTONIC elapsed time measured entirely on the
 * client (see the header) — never a difference between two machines' clocks.
 */
export function shouldBlank({
  msSinceLastFresh,
  visible,
}: {
  msSinceLastFresh: number;
  visible: boolean;
}): boolean {
  // A hidden tab is not evidence of anything: AutoRefresh has stopped polling
  // on purpose, so the elapsed time measures our own paused timer rather than
  // the network. Blanking here is what would black out the wall every time
  // someone switches the TV to the Apple TV and back.
  if (!visible) return false;
  return msSinceLastFresh > STALE_AFTER_MS;
}

export function StaleGuard({ renderedAt }: { renderedAt: string }) {
  const router = useRouter();
  const [isStale, setIsStale] = useState(false);
  const lastFreshRef = useRef<number>(0);

  // Reset the staleness clock whenever the SERVER produces a new render.
  // `renderedAt` changing is the only evidence that the round trip is alive;
  // if the network is down the prop keeps its old value and this never fires.
  //
  // ⚠️ REF WRITE ONLY, NO setState. Clearing the blackout here as well would
  // be a `react-hooks/set-state-in-effect` lint ERROR (the repo's baseline is
  // 0 errors), and it is unnecessary: the interval below sets the flag in
  // BOTH directions, so recovery clears the screen on its next tick. The cost
  // is up to CHECK_INTERVAL_MS of extra blackout after the network returns,
  // which on a wall display is not a cost at all.
  useEffect(() => {
    lastFreshRef.current = performance.now();
  }, [renderedAt]);

  useEffect(() => {
    // 🔴 THE BACKGROUNDED-TAB TRAP. AutoRefresh deliberately pauses polling
    // while document.visibilityState !== "visible", so a tab that has been
    // hidden has a stale `renderedAt` through no fault of the network. On
    // this TV that happens EVERY TIME Mark switches the input to the Apple TV
    // to watch a game and switches back -- and without this handler he would
    // return to a black screen and reasonably report the display as broken.
    //
    // So: on becoming visible, forgive the gap and immediately ask for a
    // fresh render, which gives the round trip a full STALE_AFTER_MS to land.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        lastFreshRef.current = performance.now();
        setIsStale(false);
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const id = setInterval(() => {
      // Do not accrue staleness while hidden -- nothing is polling, so the
      // measurement would be of our own paused timer rather than of the
      // network.
      // Set in BOTH directions: this is the only place the flag is raised,
      // and also the place a recovered connection lowers it again.
      setIsStale(
        shouldBlank({
          msSinceLastFresh: performance.now() - lastFreshRef.current,
          visible: document.visibilityState === "visible",
        }),
      );
    }, CHECK_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(id);
    };
  }, [router]);

  if (!isStale) return null;

  // ⚠️ A JUDGEMENT CALL, FLAGGED RATHER THAN BURIED: this is not a literally
  // empty screen. It is an opaque blackout that covers the schedule
  // completely -- no times, no names, nothing that could be misread as
  // current -- plus one dim line saying why. The line is there so that
  // someone looking at the wall can tell "the display lost its connection"
  // from "the TV is off or the input is wrong", which are different problems
  // with different fixes. It cannot be mistaken for a schedule, which is the
  // property Mark actually asked for. If he wants literally nothing, delete
  // the <p> and keep the overlay.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
    >
      <p className="text-2xl font-medium tracking-wide text-neutral-600">
        Schedule unavailable — reconnecting
      </p>
    </div>
  );
}
