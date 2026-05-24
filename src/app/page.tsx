import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect(session.user.role === "admin" ? "/admin" : "/coach");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
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
            Continue with Google
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-foreground/40">
          <div className="h-px flex-1 bg-foreground/10" />
          <span>or</span>
          <div className="h-px flex-1 bg-foreground/10" />
        </div>

        <form
          action={async (formData: FormData) => {
            "use server";
            const email = formData.get("email")?.toString().trim();
            if (!email) return;
            await signIn("resend", { email, redirectTo: "/" });
          }}
          className="space-y-2"
        >
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="w-full rounded-md border border-foreground/15 bg-transparent px-3 py-2 text-sm placeholder:text-foreground/35 focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
          <button
            type="submit"
            className="w-full rounded-md border border-foreground/15 px-4 py-2.5 text-sm font-medium hover:bg-foreground/[0.04] transition"
          >
            Email me a sign-in link
          </button>
        </form>

        <p className="text-center text-xs text-foreground/40">
          New here? Just sign in — your account is created automatically.
        </p>
      </div>
    </main>
  );
}
