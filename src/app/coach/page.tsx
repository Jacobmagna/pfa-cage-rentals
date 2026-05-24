import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

export default async function CoachHome() {
  const session = await auth();
  if (!session?.user) redirect("/");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
      <div className="w-full max-w-md space-y-2 text-center">
        <p className="text-xs uppercase tracking-wider text-foreground/50">
          Coach
        </p>
        <h1 className="text-2xl font-semibold">
          Welcome, {session.user.name ?? session.user.email}
        </h1>
        <p className="text-sm text-foreground/60">
          Phase 1 foundation. Session logging lands in Phase 3.
        </p>
      </div>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button
          type="submit"
          className="rounded-md border border-foreground/15 px-3 py-1.5 text-xs hover:bg-foreground/[0.04]"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
