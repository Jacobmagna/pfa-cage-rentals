import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect(session.user.role === "admin" ? "/admin" : "/coach");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            PFA Cage Rentals
          </h1>
          <p className="text-sm text-foreground/60">
            Sign in to log a session or pull a report.
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md border border-foreground/15 bg-foreground/[0.03] px-4 py-2.5 text-sm font-medium hover:bg-foreground/[0.06] transition"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  );
}
