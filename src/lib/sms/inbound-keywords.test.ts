import { describe, expect, it } from "vitest";

import { classifyInboundKeyword } from "./inbound-keywords";

describe("classifyInboundKeyword", () => {
  it("classifies the STOP family", () => {
    for (const w of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      expect(classifyInboundKeyword(w)).toBe("stop");
    }
  });

  it("classifies the HELP family", () => {
    for (const w of ["HELP", "INFO"]) {
      expect(classifyInboundKeyword(w)).toBe("help");
    }
  });

  it("classifies the START family", () => {
    for (const w of ["START", "YES", "UNSTOP"]) {
      expect(classifyInboundKeyword(w)).toBe("start");
    }
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(classifyInboundKeyword("  stop  ")).toBe("stop");
    expect(classifyInboundKeyword("Help")).toBe("help");
    expect(classifyInboundKeyword("\tYes\n")).toBe("start");
  });

  it("matches only the first token (ignores trailing words)", () => {
    expect(classifyInboundKeyword("STOP please")).toBe("stop");
    expect(classifyInboundKeyword("help me")).toBe("help");
  });

  it("returns none for unknown / empty / nullish input", () => {
    expect(classifyInboundKeyword("hello there")).toBe("none");
    expect(classifyInboundKeyword("")).toBe("none");
    expect(classifyInboundKeyword("   ")).toBe("none");
    expect(classifyInboundKeyword(null)).toBe("none");
    expect(classifyInboundKeyword(undefined)).toBe("none");
  });
});
