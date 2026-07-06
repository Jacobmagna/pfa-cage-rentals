// Travel-local type augmentation. ADDITIVE — kept OUT of the shared
// `types/next-auth.d.ts` (facility-owned) so the travel slice does not touch a
// shared file. Module augmentation merges globally, so this adds `travelAdmin`
// to the next-auth `User` interface (adapter user rows) alongside the
// facility's `role`/`scheduleAdmin` fields.
//
// The facility file types `Session.user` as a CLOSED inline intersection that
// interface merging cannot extend, so the travel session's `travelAdmin` view
// is expressed via the `TravelSessionUser` type in src/travel/authz.ts (read
// side) and a widened cast in src/travel/auth.ts (write side) instead.
//
// Optional (`travelAdmin?`) so it stays purely additive.
import "next-auth";

declare module "next-auth" {
  interface User {
    travelAdmin?: boolean;
  }
}
