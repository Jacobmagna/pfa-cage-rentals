import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "coach" | "admin";
      scheduleAdmin: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role?: "coach" | "admin";
    scheduleAdmin?: boolean;
  }
}
