# Coach onboarding email — template

Send this manually from Mike's PFA email to each coach when adding
them to the new system. Edit the bracketed values and trim/expand
the body to taste.

---

**Subject:** PFA Cage Rentals — new way to log your time

**To:** `[coach@example.com]`

**From:** `mdm@pfasports.com`

---

Hi `[Coach First Name]`,

Quick heads-up: we're moving the cage / bullpen / weight-room rental
tracker off the shared Excel and onto a real web app. You'll log your
sessions here instead of texting me the times:

**[pfaengine.com](https://pfaengine.com)**

### What's the same
- You still rent the same cages, bullpens, and the weight room.
- Your hourly rate is the same. Nothing about how I bill you is
  changing.
- I'll still send you a monthly summary the same way I always have.

### What's different
- You log your own sessions in the app instead of telling me. Takes
  about 15 seconds per session.
- You can see your running monthly total any time you want.
- If the cage you want is already booked, the app will tell you who
  has it so you can text them directly.

### How to sign in (first time)
1. Open **[pfaengine.com](https://pfaengine.com)** on your
   phone or laptop.
2. Click **Continue with Google** if your PFA address is a Gmail
   account — that's the fastest path. Otherwise enter your email and
   click "Email me a sign-in link" and click the link that arrives in
   your inbox.
3. The first thing you'll see is your dashboard. Add a session by
   clicking **Log a session** and picking your date, time, and cage.

### One favor
For the first week, please **also** keep doing whatever you do today
(texting me, jotting it on paper, whatever) as a backup. We'll
compare and make sure nothing got missed. After a week we'll cut over
fully.

### Help
- If something's broken or confusing, text me or reply to this
  email. I'd rather hear about it than have you give up.
- Account questions (changing your name, deleting your account, etc.)
  — email me at mdm@pfasports.com.

Thanks for being patient with the upgrade.

— Mike

---

## Sender notes (don't include in the email)

- This template assumes the coach already has a PFA-issued or
  personal Google account, OR an email they check regularly. If they
  have neither, send the magic-link version and mention they'll need
  to keep the email handy each session.
- After hitting send, the coach won't appear in `/admin/coaches`
  until they actually sign in for the first time (Auth.js creates
  the row on first sign-in). If you want them visible in the picker
  before then, follow the "Add a new coach manually" section in
  [docs/operations/runbook.md](./runbook.md).
- During the soft launch (K8), send this only to the 2–3 friendly
  pilot coaches first. Watch their feedback for a few days before
  expanding to the full roster.
