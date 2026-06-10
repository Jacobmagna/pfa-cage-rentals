import { describe, expect, it } from "vitest";

import {
  computeTwilioSignature,
  validateTwilioSignature,
} from "./twilio-signature";

const AUTH_TOKEN = "test_auth_token_1234567890";
const URL = "https://pfaengine.com/api/sms/inbound";
const PARAMS = {
  From: "+14155550101",
  Body: "STOP",
  MessageSid: "SM00000000000000000000000000000001",
};

describe("validateTwilioSignature", () => {
  it("accepts a signature it computed itself (round-trip)", () => {
    const signature = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: PARAMS,
    });
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: PARAMS,
        signature,
      }),
    ).toBe(true);
  });

  it("is independent of param insertion order (sorted by key)", () => {
    const a = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: { Body: "STOP", From: "+14155550101" },
    });
    const b = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: { From: "+14155550101", Body: "STOP" },
    });
    expect(a).toBe(b);
  });

  it("rejects a tampered signature", () => {
    const signature = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: PARAMS,
    });
    const tampered = `${signature.slice(0, -1)}${
      signature.endsWith("A") ? "B" : "A"
    }`;
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: PARAMS,
        signature: tampered,
      }),
    ).toBe(false);
  });

  it("rejects when a body param differs from what was signed", () => {
    const signature = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: PARAMS,
    });
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: { ...PARAMS, Body: "START" },
        signature,
      }),
    ).toBe(false);
  });

  it("rejects when the URL differs from what was signed", () => {
    const signature = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: PARAMS,
    });
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: "https://evil.example.com/api/sms/inbound",
        params: PARAMS,
        signature,
      }),
    ).toBe(false);
  });

  it("rejects under the wrong auth token", () => {
    const signature = computeTwilioSignature({
      authToken: AUTH_TOKEN,
      url: URL,
      params: PARAMS,
    });
    expect(
      validateTwilioSignature({
        authToken: "a_different_token",
        url: URL,
        params: PARAMS,
        signature,
      }),
    ).toBe(false);
  });

  it("returns false on empty signature or empty token (no throw)", () => {
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL,
        params: PARAMS,
        signature: "",
      }),
    ).toBe(false);
    expect(
      validateTwilioSignature({
        authToken: "",
        url: URL,
        params: PARAMS,
        signature: "anything",
      }),
    ).toBe(false);
  });
});
