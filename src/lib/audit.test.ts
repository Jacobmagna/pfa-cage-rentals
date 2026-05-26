// Unit tests for src/lib/audit.ts. `shallowDiff` is pure — no DB
// involvement — so this file lives alongside billing.test.ts under
// vitest.config.ts (the 100%-coverage unit suite), not the
// integration suite.
//
// What this locks down:
//   - Equal-by-value semantics (primitives, Date.getTime, NaN).
//   - Reference-distinct-but-value-equal Date instances do NOT diff.
//     This is the load-bearing case for the audit log: Drizzle hands
//     back a fresh Date object for every row read, so without
//     Date-aware equality every UPDATE would emit a diff for every
//     timestamp column and the audit page would be noise.
//   - Added / removed / changed keys all surface in the diff.
//   - Nested objects + arrays are compared by reference, NOT
//     recursively. shallowDiff is "shallow" by name — confirmed via
//     tests so a future "let's deepEqual it" refactor doesn't slip
//     through silently.

import { describe, expect, it } from "vitest";
import { shallowDiff } from "@/lib/audit";

describe("shallowDiff", () => {
  it("returns empty before/after for two empty objects", () => {
    const { before, after } = shallowDiff({}, {});
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("returns empty before/after when every key has an equal primitive value", () => {
    const { before, after } = shallowDiff(
      { a: 1, b: "x", c: true, d: null },
      { a: 1, b: "x", c: true, d: null },
    );
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("includes a key whose value changed", () => {
    const { before, after } = shallowDiff(
      { a: 1, b: "x" },
      { a: 2, b: "x" },
    );
    expect(before).toEqual({ a: 1 });
    expect(after).toEqual({ a: 2 });
  });

  it("includes a key present only in `after` with undefined before", () => {
    const { before, after } = shallowDiff({ a: 1 }, { a: 1, b: "new" });
    expect(before).toEqual({ b: undefined });
    expect(after).toEqual({ b: "new" });
  });

  it("includes a key present only in `before` with undefined after", () => {
    const { before, after } = shallowDiff({ a: 1, b: "old" }, { a: 1 });
    expect(before).toEqual({ b: "old" });
    expect(after).toEqual({ b: undefined });
  });

  it("treats two Date instances with the same epoch as equal (no diff)", () => {
    // This is the critical behavior: Drizzle returns a fresh Date
    // instance for every row read, so before/after the same UPDATE we
    // have reference-distinct but value-equal Date objects on unchanged
    // timestamp columns. Without this branch every update would diff
    // every Date column.
    const t = Date.UTC(2026, 0, 15, 12, 0, 0);
    const { before, after } = shallowDiff(
      { createdAt: new Date(t) },
      { createdAt: new Date(t) },
    );
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("treats two Date instances with different epochs as a change", () => {
    const a = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    const b = new Date(Date.UTC(2026, 0, 15, 12, 30, 0));
    const { before, after } = shallowDiff({ at: a }, { at: b });
    expect(before).toEqual({ at: a });
    expect(after).toEqual({ at: b });
  });

  it("treats a Date vs a non-Date as a change even when the values look similar", () => {
    const d = new Date(Date.UTC(2026, 0, 15));
    const { before, after } = shallowDiff({ at: d }, { at: d.toISOString() });
    expect(before).toEqual({ at: d });
    expect(after).toEqual({ at: d.toISOString() });
  });

  it("does NOT deep-compare nested objects — distinct refs always diff", () => {
    // shallowDiff is shallow by contract. {a: 1} and {a: 1} are
    // distinct references, so they show up as a change even though
    // they're structurally identical. Documenting this so a future
    // "let's deepEqual" refactor has to update the test deliberately.
    const left = { meta: { a: 1 } };
    const right = { meta: { a: 1 } };
    const { before, after } = shallowDiff(left, right);
    expect(before).toEqual({ meta: { a: 1 } });
    expect(after).toEqual({ meta: { a: 1 } });
  });

  it("does NOT diff when the nested object is the SAME reference", () => {
    const nested = { a: 1 };
    const { before, after } = shallowDiff({ meta: nested }, { meta: nested });
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("does NOT deep-compare arrays — distinct refs always diff", () => {
    // Same shallow-by-contract rule. [1,2] vs [1,2] are distinct
    // references → diff.
    const { before, after } = shallowDiff({ ids: [1, 2] }, { ids: [1, 2] });
    expect(before).toEqual({ ids: [1, 2] });
    expect(after).toEqual({ ids: [1, 2] });
  });

  it("does NOT diff when the array is the SAME reference", () => {
    const arr = [1, 2, 3];
    const { before, after } = shallowDiff({ ids: arr }, { ids: arr });
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("treats null and undefined as distinct", () => {
    const { before, after } = shallowDiff({ x: null }, { x: undefined });
    expect(before).toEqual({ x: null });
    expect(after).toEqual({ x: undefined });
  });

  it("treats NaN as equal to NaN (Object.is semantics)", () => {
    // Object.is handles NaN correctly (unlike ===), and we rely on that.
    const { before, after } = shallowDiff({ x: NaN }, { x: NaN });
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it("treats 0 and -0 as distinct (Object.is semantics)", () => {
    // Object.is(0, -0) === false. Worth pinning so a future swap to
    // === wouldn't silently change behavior.
    const { before, after } = shallowDiff({ x: 0 }, { x: -0 });
    expect(before).toEqual({ x: 0 });
    expect(after).toEqual({ x: -0 });
  });

  it("only includes the keys that changed, leaving equal keys out", () => {
    const { before, after } = shallowDiff(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 99, c: 3 },
    );
    expect(before).toEqual({ b: 2 });
    expect(after).toEqual({ b: 99 });
    expect("a" in before).toBe(false);
    expect("c" in before).toBe(false);
  });

  it("handles a mix of changes, adds, and removes in one diff", () => {
    const { before, after } = shallowDiff(
      { a: 1, b: 2, removed: "gone" },
      { a: 1, b: 99, added: "new" },
    );
    expect(before).toEqual({ b: 2, removed: "gone", added: undefined });
    expect(after).toEqual({ b: 99, removed: undefined, added: "new" });
  });
});
