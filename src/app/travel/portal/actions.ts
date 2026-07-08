"use server";

import { redirect } from "next/navigation";
import { destroyTravelGuardianSession } from "@/travel/session";

/**
 * Sign the current parent (guardian) out: end their guardian session (delete the
 * session row + clear the cookie), then send them to the travel sign-in page.
 */
export async function signOutTravel() {
  await destroyTravelGuardianSession();
  redirect("/travel/signin");
}
