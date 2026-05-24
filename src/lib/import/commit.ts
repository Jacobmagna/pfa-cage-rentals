import type { NormalizedSession } from "./normalize";

export type DecisionAction = "auto" | "map" | "create" | "skip";

export type Decision = {
  rawName: string;
  action: DecisionAction;
  mappedUserId?: string;
};

export type ExistingUserLite = {
  id: string;
  name: string | null;
  email: string;
};

export type GroupSummary = {
  rawName: string;
  canonicalName: string;
  confidence: NormalizedSession["confidence"];
  count: number;
  existingUserMatch: ExistingUserLite | null;
  suggestedAction: DecisionAction;
};

export type PlannedSession = {
  source: NormalizedSession;
  coachKey: string;
  note: string | null;
};

export type PlannedCoach = {
  key: string;
  name: string;
  email: string;
};

export type CommitPlan = {
  coachUsers: {
    existingByKey: Map<string, ExistingUserLite>;
    toCreate: Map<string, PlannedCoach>;
  };
  sessionsToInsert: PlannedSession[];
  skipped: { rawName: string; reason: string; count: number }[];
};

// Groups normalized sessions by raw name and pairs each group with a
// suggested decision. Used to render the preview UI before the admin
// makes per-group calls.
export function buildGroupSummaries(
  sessions: NormalizedSession[],
  existingUsers: ExistingUserLite[],
): GroupSummary[] {
  const byName = new Map<string, NormalizedSession[]>();
  for (const s of sessions) {
    const arr = byName.get(s.rawName);
    if (arr) arr.push(s);
    else byName.set(s.rawName, [s]);
  }

  const userByLowerName = new Map<string, ExistingUserLite>();
  for (const u of existingUsers) {
    if (u.name) userByLowerName.set(u.name.toLowerCase(), u);
  }

  const out: GroupSummary[] = [];
  for (const [rawName, group] of byName) {
    const first = group[0];
    const existingUserMatch = userByLowerName.get(first.canonicalName.toLowerCase()) ?? null;
    out.push({
      rawName,
      canonicalName: first.canonicalName,
      confidence: first.confidence,
      count: group.length,
      existingUserMatch,
      suggestedAction: defaultActionFor(first.confidence, existingUserMatch),
    });
  }
  return out.sort((a, b) => {
    const order = { unmatched: 0, cleaned: 1, fuzzy: 2, alias: 3 } as const;
    const diff = order[a.confidence] - order[b.confidence];
    if (diff !== 0) return diff;
    return b.count - a.count;
  });
}

function defaultActionFor(
  confidence: NormalizedSession["confidence"],
  existingUserMatch: ExistingUserLite | null,
): DecisionAction {
  if (existingUserMatch) return "map";
  if (confidence === "alias" || confidence === "fuzzy") return "create";
  if (confidence === "cleaned") return "create";
  return "skip";
}

// Pure plan builder. Given normalized sessions + admin decisions +
// existing user lookup, produce the work that needs to be done.
// No DB calls — execute step lives in src/lib/server/import-actions.ts.
export function buildCommitPlan(
  sessions: NormalizedSession[],
  decisions: Decision[],
  existingUsers: ExistingUserLite[],
): CommitPlan {
  const decisionByRaw = new Map<string, Decision>();
  for (const d of decisions) decisionByRaw.set(d.rawName, d);

  const userById = new Map<string, ExistingUserLite>();
  for (const u of existingUsers) userById.set(u.id, u);

  const userByLowerName = new Map<string, ExistingUserLite>();
  for (const u of existingUsers) {
    if (u.name) userByLowerName.set(u.name.toLowerCase(), u);
  }

  const existingByKey = new Map<string, ExistingUserLite>();
  const toCreate = new Map<string, PlannedCoach>();
  const sessionsToInsert: PlannedSession[] = [];
  const skipped: CommitPlan["skipped"] = [];

  const groupCounts = new Map<string, number>();
  for (const s of sessions) {
    groupCounts.set(s.rawName, (groupCounts.get(s.rawName) ?? 0) + 1);
  }

  for (const s of sessions) {
    const decision: Decision = decisionByRaw.get(s.rawName) ?? { rawName: s.rawName, action: "auto" };

    if (decision.action === "skip") {
      continue;
    }

    let coachKey: string;
    if (decision.action === "map") {
      if (!decision.mappedUserId) {
        skipped.push({ rawName: s.rawName, reason: "map action missing userId", count: 1 });
        continue;
      }
      const user = userById.get(decision.mappedUserId);
      if (!user) {
        skipped.push({ rawName: s.rawName, reason: `mapped userId ${decision.mappedUserId} not found`, count: 1 });
        continue;
      }
      coachKey = `existing:${user.id}`;
      if (!existingByKey.has(coachKey)) existingByKey.set(coachKey, user);
    } else {
      // "auto" or "create" — both look up by canonical name, then fall through to creating
      // a new pseudo-coach. Empty canonical name → skip (defensive; the UI suggests "skip"
      // for unmatched groups, but if admin overrides, we don't insert blanks).
      if (s.canonicalName.trim() === "") {
        skipped.push({ rawName: s.rawName, reason: "empty canonical name", count: 1 });
        continue;
      }
      const existing = userByLowerName.get(s.canonicalName.toLowerCase());
      if (existing) {
        coachKey = `existing:${existing.id}`;
        if (!existingByKey.has(coachKey)) existingByKey.set(coachKey, existing);
      } else {
        coachKey = `new:${s.canonicalName.toLowerCase()}`;
        if (!toCreate.has(coachKey)) {
          toCreate.set(coachKey, {
            key: coachKey,
            name: s.canonicalName,
            email: syntheticEmailFor(s.canonicalName),
          });
        }
      }
    }

    sessionsToInsert.push({ source: s, coachKey, note: s.note });
  }

  // Collapse single-row skipped reasons by rawName for tidier reporting.
  const collapsedSkipped = new Map<string, { rawName: string; reason: string; count: number }>();
  for (const sk of skipped) {
    const key = `${sk.rawName}::${sk.reason}`;
    const prev = collapsedSkipped.get(key);
    if (prev) prev.count += sk.count;
    else collapsedSkipped.set(key, { ...sk });
  }
  // Add skip-decision groups as a single skipped entry per rawName.
  for (const d of decisions) {
    if (d.action === "skip") {
      const count = groupCounts.get(d.rawName) ?? 0;
      if (count > 0) {
        collapsedSkipped.set(`${d.rawName}::admin-skip`, {
          rawName: d.rawName,
          reason: "admin chose skip",
          count,
        });
      }
    }
  }

  return {
    coachUsers: { existingByKey, toCreate },
    sessionsToInsert,
    skipped: Array.from(collapsedSkipped.values()),
  };
}

export function syntheticEmailFor(canonicalName: string): string {
  const slug = canonicalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `historical-${slug || "unknown"}@imported.local`;
}
