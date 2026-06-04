import { describe, expect, it } from "vitest";
import { formatRelative } from "./format-relative";

const NOW = new Date("2026-06-03T12:00:00.000Z");

describe("formatRelative", () => {
  it("returns 'just now' under a minute", () => {
    expect(formatRelative(new Date(NOW.getTime() - 30_000), NOW)).toBe(
      "just now",
    );
  });

  it("returns minutes under an hour", () => {
    expect(formatRelative(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe(
      "5m ago",
    );
  });

  it("returns hours under a day", () => {
    expect(
      formatRelative(new Date(NOW.getTime() - 3 * 60 * 60_000), NOW),
    ).toBe("3h ago");
  });

  it("returns days under a week", () => {
    expect(
      formatRelative(new Date(NOW.getTime() - 2 * 24 * 60 * 60_000), NOW),
    ).toBe("2d ago");
  });

  it("falls back to an absolute date a week or more out", () => {
    const result = formatRelative(
      new Date(NOW.getTime() - 10 * 24 * 60 * 60_000),
      NOW,
    );
    expect(result).not.toMatch(/ago/);
    expect(result).not.toBe("just now");
  });
});
