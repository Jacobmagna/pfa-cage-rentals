import { describe, expect, it } from "vitest";
import {
  renderReminderBody,
  SmsSendError,
  TWILIO_OPT_OUT_CODE,
} from "./client";

describe("renderReminderBody", () => {
  it("renders the EXACT locked copy with the link interpolated", () => {
    const link = "https://pfaengine.com/coach/hour-log";
    expect(renderReminderBody(link)).toBe(
      `PFA Engine: You had work scheduled yesterday that hasn't been logged. Please log it: ${link} Reply STOP to opt out.`,
    );
  });

  it("keeps the STOP opt-out instruction in the body (carrier compliance)", () => {
    expect(renderReminderBody("x")).toContain("Reply STOP to opt out.");
  });

  it("starts with the PFA Engine brand prefix (no sender ID needed)", () => {
    expect(renderReminderBody("x").startsWith("PFA Engine:")).toBe(true);
  });
});

describe("SmsSendError.isOptOut", () => {
  it("is true for Twilio's opt-out code 21610", () => {
    expect(TWILIO_OPT_OUT_CODE).toBe(21610);
    expect(new SmsSendError(TWILIO_OPT_OUT_CODE, "opted out").isOptOut).toBe(
      true,
    );
  });

  it("is false for any other Twilio code", () => {
    expect(new SmsSendError(21211, "invalid To").isOptOut).toBe(false);
  });

  it("is false when no code is present", () => {
    expect(new SmsSendError(null, "network error").isOptOut).toBe(false);
  });
});
