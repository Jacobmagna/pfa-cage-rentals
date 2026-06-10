import { describe, expect, it } from "vitest";
import {
  renderReminderBody,
  SMS_LOG_URL,
  SmsSendError,
  TWILIO_OPT_OUT_CODE,
} from "./client";

describe("renderReminderBody", () => {
  it("renders the EXACT registered A2P copy with the link interpolated", () => {
    const link = SMS_LOG_URL;
    expect(renderReminderBody(link)).toBe(
      `PFA Engine: Hi Coach — you haven't logged your work for yesterday yet. Log it here: ${link} Reply STOP to opt out, HELP for help.`,
    );
  });

  it("keeps the STOP opt-out instruction in the body (carrier compliance)", () => {
    expect(renderReminderBody("x")).toContain("Reply STOP to opt out");
  });

  it("includes the HELP instruction (carrier compliance)", () => {
    expect(renderReminderBody("x")).toContain("HELP for help.");
  });

  it("starts with the PFA Engine brand prefix (no sender ID needed)", () => {
    expect(renderReminderBody("x").startsWith("PFA Engine:")).toBe(true);
  });

  it("uses the bare pfaengine.com apex domain (matches registered sample)", () => {
    expect(SMS_LOG_URL).toBe("https://pfaengine.com/coach/hour-log");
    expect(renderReminderBody(SMS_LOG_URL)).toContain(
      "https://pfaengine.com/coach/hour-log",
    );
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
