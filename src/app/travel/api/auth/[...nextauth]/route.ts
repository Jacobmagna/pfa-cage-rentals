// Travel auth HTTP endpoints. Mirrors the facility route
// (src/app/api/auth/[...nextauth]/route.ts) but exports the TRAVEL handlers.
// Reachable at /travel/api/auth/* (the travel auth basePath).
import { handlers } from "@/travel/auth";
export const { GET, POST } = handlers;
