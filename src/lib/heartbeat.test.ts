import { afterEach, describe, expect, it, vi } from "vitest";

import { pingHeartbeat } from "./heartbeat";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("pingHeartbeat", () => {
  it("does NOT call fetch and resolves when url is undefined", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(pingHeartbeat(undefined)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls fetch once with the given url when url is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    global.fetch = fetchMock as unknown as typeof fetch;

    await pingHeartbeat("https://heartbeat.example/abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://heartbeat.example/abc");
  });

  it("still resolves (does not throw) when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      pingHeartbeat("https://heartbeat.example/abc"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
