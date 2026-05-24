import { describe, expect, it } from "vitest";
import {
  buildCommitPlan,
  buildGroupSummaries,
  syntheticEmailFor,
  type Decision,
  type ExistingUserLite,
} from "./commit";
import type { NormalizedSession } from "./normalize";

function ns(overrides: Partial<NormalizedSession>): NormalizedSession {
  return {
    date: "2026-05-01",
    resourceName: "Cage 1",
    useTypeHint: "pitching",
    rawName: "D. Lusk",
    startTime: "14:30",
    endTime: "15:00",
    sourceTab: "May 1-3",
    canonicalName: "David Lusk",
    note: null,
    confidence: "alias",
    ...overrides,
  };
}

const NO_USERS: ExistingUserLite[] = [];

describe("syntheticEmailFor", () => {
  it("slugifies canonical names", () => {
    expect(syntheticEmailFor("David Lusk")).toBe("historical-david-lusk@imported.local");
    expect(syntheticEmailFor("J. Tyler")).toBe("historical-j-tyler@imported.local");
    expect(syntheticEmailFor("PFA Travel")).toBe("historical-pfa-travel@imported.local");
  });

  it("falls back to 'unknown' for empty input", () => {
    expect(syntheticEmailFor("")).toBe("historical-unknown@imported.local");
  });
});

describe("buildGroupSummaries", () => {
  it("groups by raw name and suggests default actions per confidence", () => {
    const sessions = [
      ns({ rawName: "D. Lusk" }),
      ns({ rawName: "D. Lusk" }),
      ns({ rawName: "(TEST)", canonicalName: "", confidence: "unmatched" }),
      ns({ rawName: "Brand New Coach", canonicalName: "Brand New Coach", confidence: "cleaned" }),
    ];
    const groups = buildGroupSummaries(sessions, NO_USERS);
    expect(groups).toHaveLength(3);

    // Sorted unmatched first
    expect(groups[0].rawName).toBe("(TEST)");
    expect(groups[0].suggestedAction).toBe("skip");

    expect(groups[1].rawName).toBe("Brand New Coach");
    expect(groups[1].suggestedAction).toBe("create");

    const lusk = groups.find((g) => g.rawName === "D. Lusk");
    expect(lusk).toBeDefined();
    expect(lusk!.count).toBe(2);
    expect(lusk!.suggestedAction).toBe("create");
  });

  it("suggests map when an existing user matches the canonical name", () => {
    const user: ExistingUserLite = { id: "u1", name: "David Lusk", email: "david@example.com" };
    const groups = buildGroupSummaries([ns({})], [user]);
    expect(groups[0].existingUserMatch).toEqual(user);
    expect(groups[0].suggestedAction).toBe("map");
  });
});

describe("buildCommitPlan", () => {
  it("auto-imports alias-confidence sessions and creates new coach users", () => {
    const sessions = [ns({}), ns({ startTime: "15:00", endTime: "15:30" })];
    const plan = buildCommitPlan(sessions, [], NO_USERS);
    expect(plan.sessionsToInsert).toHaveLength(2);
    expect(plan.coachUsers.toCreate.size).toBe(1);
    const newCoach = Array.from(plan.coachUsers.toCreate.values())[0];
    expect(newCoach.name).toBe("David Lusk");
    expect(newCoach.email).toBe("historical-david-lusk@imported.local");
    expect(plan.coachUsers.existingByKey.size).toBe(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("maps to an existing user when one matches by name", () => {
    const user: ExistingUserLite = { id: "u1", name: "David Lusk", email: "david@example.com" };
    const plan = buildCommitPlan([ns({})], [], [user]);
    expect(plan.coachUsers.existingByKey.size).toBe(1);
    expect(plan.coachUsers.toCreate.size).toBe(0);
    expect(plan.sessionsToInsert[0].coachKey).toBe("existing:u1");
  });

  it("honors a 'skip' decision and reports the skipped count", () => {
    const sessions = [ns({}), ns({ startTime: "15:00", endTime: "15:30" })];
    const decisions: Decision[] = [{ rawName: "D. Lusk", action: "skip" }];
    const plan = buildCommitPlan(sessions, decisions, NO_USERS);
    expect(plan.sessionsToInsert).toHaveLength(0);
    expect(plan.skipped).toEqual([
      { rawName: "D. Lusk", reason: "admin chose skip", count: 2 },
    ]);
  });

  it("honors a 'map' decision to a specific user id", () => {
    const userA: ExistingUserLite = { id: "uA", name: "Tyler Knox", email: "tk@example.com" };
    const userB: ExistingUserLite = { id: "uB", name: "J. Tyler", email: "jt@example.com" };
    const sessions = [
      ns({ rawName: "Tyler member", canonicalName: "Tyler Member", confidence: "cleaned" }),
    ];
    const decisions: Decision[] = [
      { rawName: "Tyler member", action: "map", mappedUserId: "uB" },
    ];
    const plan = buildCommitPlan(sessions, decisions, [userA, userB]);
    expect(plan.sessionsToInsert).toHaveLength(1);
    expect(plan.sessionsToInsert[0].coachKey).toBe("existing:uB");
    expect(plan.coachUsers.existingByKey.get("existing:uB")).toEqual(userB);
  });

  it("skips sessions with missing/invalid mapped userId", () => {
    const sessions = [ns({})];
    const decisions: Decision[] = [
      { rawName: "D. Lusk", action: "map", mappedUserId: "does-not-exist" },
    ];
    const plan = buildCommitPlan(sessions, decisions, NO_USERS);
    expect(plan.sessionsToInsert).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/not found/i);
  });

  it("defaults unmatched-confidence sessions to skip", () => {
    const sessions = [
      ns({ rawName: "8733", canonicalName: "", confidence: "unmatched" }),
    ];
    const plan = buildCommitPlan(sessions, [], NO_USERS);
    expect(plan.sessionsToInsert).toHaveLength(0);
  });

  it("collapses duplicate new-coach inserts to one user", () => {
    const sessions = [
      ns({ rawName: "D. Lusk" }),
      ns({ rawName: "Lusk", canonicalName: "David Lusk" }),
      ns({ rawName: "David Lusk", canonicalName: "David Lusk" }),
    ];
    const plan = buildCommitPlan(sessions, [], NO_USERS);
    expect(plan.coachUsers.toCreate.size).toBe(1);
    expect(plan.sessionsToInsert).toHaveLength(3);
  });
});
