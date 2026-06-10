import { describe, expect, it } from "vitest";

import { K_DEFAULT, anonId, dimsHash, meetsK } from "./anonymize";

describe("anonId", () => {
  it("is deterministic for the same (salt, namespace, rawId)", () => {
    expect(anonId("s1", "coach", "abc")).toBe(anonId("s1", "coach", "abc"));
  });

  it("changes when the salt changes (not reversible without salt)", () => {
    expect(anonId("s1", "coach", "abc")).not.toBe(
      anonId("s2", "coach", "abc"),
    );
  });

  it("separates namespaces — same rawId, different domain → different token", () => {
    expect(anonId("s1", "coach", "abc")).not.toBe(
      anonId("s1", "athlete", "abc"),
    );
  });

  it("changes when the rawId changes", () => {
    expect(anonId("s1", "coach", "abc")).not.toBe(
      anonId("s1", "coach", "xyz"),
    );
  });

  it("is exactly 16 chars and base64url (no +/= padding)", () => {
    const token = anonId("s1", "coach", "abc");
    expect(token).toHaveLength(16);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("never contains the raw id", () => {
    const token = anonId("salty", "coach", "coach-real-id-12345");
    expect(token).not.toContain("coach-real-id");
  });
});

describe("meetsK", () => {
  it("suppresses below k (4 < 5 → false)", () => {
    expect(meetsK(4, 5)).toBe(false);
  });
  it("allows at the boundary (5 >= 5 → true)", () => {
    expect(meetsK(5, 5)).toBe(true);
  });
  it("allows above k", () => {
    expect(meetsK(99, 5)).toBe(true);
  });
  it("K_DEFAULT is 5", () => {
    expect(K_DEFAULT).toBe(5);
  });
});

describe("dimsHash", () => {
  it("returns '' for empty / null / undefined dims", () => {
    expect(dimsHash(undefined)).toBe("");
    expect(dimsHash(null)).toBe("");
    expect(dimsHash({})).toBe("");
  });

  it("is stable under key reorder", () => {
    expect(dimsHash({ a: "1", b: 2 })).toBe(dimsHash({ b: 2, a: "1" }));
  });

  it("differs when a value differs", () => {
    expect(dimsHash({ a: "1" })).not.toBe(dimsHash({ a: "2" }));
  });

  it("differs from '' when dims are present", () => {
    expect(dimsHash({ a: "1" })).not.toBe("");
  });

  it("is a sha256 hex string", () => {
    expect(dimsHash({ resource_type: "cage" })).toMatch(/^[0-9a-f]{64}$/);
  });
});
