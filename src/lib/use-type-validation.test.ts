// Unit tests for the cage use-type rule + its friendly inline copy.
//
// Background (QA10 W1.5): a coach logging a CAGE session with the
// "Use type" left blank used to get a generic "Server Components
// render" crash on the multi-slot batch path — the batch server
// action throws UseTypeValidationError, and an uncaught server-action
// throw is message-redacted in production. The fix routes a friendly
// message through the form's existing inline error channel; these
// tests pin both the rule and the exact copy.

import { describe, expect, it } from "vitest";
import {
  CAGE_USE_TYPE_REQUIRED_MESSAGE,
  cageUseTypeError,
} from "./use-type-validation";

describe("cageUseTypeError", () => {
  it("flags a cage with a blank use type with the friendly message (not a thrown crash)", () => {
    expect(cageUseTypeError("cage", null)).toBe(CAGE_USE_TYPE_REQUIRED_MESSAGE);
    expect(cageUseTypeError("cage", undefined)).toBe(
      CAGE_USE_TYPE_REQUIRED_MESSAGE,
    );
  });

  it("uses the exact client-facing copy", () => {
    expect(CAGE_USE_TYPE_REQUIRED_MESSAGE).toBe(
      "Select hitting or pitching for cage sessions.",
    );
  });

  it("accepts a cage with hitting or pitching", () => {
    expect(cageUseTypeError("cage", "hitting")).toBeNull();
    expect(cageUseTypeError("cage", "pitching")).toBeNull();
  });

  it("accepts a bullpen or weight room with a blank use type", () => {
    expect(cageUseTypeError("bullpen", null)).toBeNull();
    expect(cageUseTypeError("bullpen", undefined)).toBeNull();
    expect(cageUseTypeError("weight_room", null)).toBeNull();
    expect(cageUseTypeError("weight_room", undefined)).toBeNull();
  });

  it("never throws — returns a value for every (resourceType, useType) pair", () => {
    expect(() => cageUseTypeError("cage", null)).not.toThrow();
    expect(() => cageUseTypeError("bullpen", "hitting")).not.toThrow();
  });
});
