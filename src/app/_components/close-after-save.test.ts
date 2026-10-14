// Unit tests for closeAfterOk, the pure core of the close-after-save wrapper
// the save dialogs hand to useActionState. The hook around it (refs, the
// mounted/open guard) needs a React renderer that can drive useActionState,
// which this repo's node-only test setup does not have; the stuck-saving
// diagnosis harness covers it on a production build.

import { describe, expect, it, vi } from "vitest";
import { closeAfterOk } from "./close-after-save";

type Result =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

describe("closeAfterOk", () => {
  it("a saved result: close is called once, AFTER the action has answered, and the result is returned unchanged", async () => {
    const order: string[] = [];
    let answer!: (r: Result) => void;
    const action = (prev: Result, formData: FormData) => {
      void prev;
      void formData;
      return new Promise<Result>((resolve) => {
        answer = resolve;
      });
    };
    const close = vi.fn(() => order.push("close"));

    const wrapped = closeAfterOk(action, close);
    const pending = wrapped({ ok: true }, new FormData());

    // Not closed while the server has not answered.
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    order.push("answered");
    answer({ ok: true });
    const result = await pending;

    expect(result).toEqual({ ok: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["answered", "close"]);
  });

  it("passes its arguments straight through to the action", async () => {
    const seen: unknown[][] = [];
    const action = async (...args: [Result, FormData]): Promise<Result> => {
      seen.push(args);
      return { ok: true };
    };
    const fd = new FormData();
    fd.set("note", "x");
    const prev: Result = { ok: true };

    await closeAfterOk(action, () => {})(prev, fd);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(prev);
    expect(seen[0][1]).toBe(fd);
  });

  it("a refused result: close is NOT called, and the refusal is returned unchanged", async () => {
    const refusal: Result = {
      ok: false,
      error: { code: "SESSION_OVERLAP", message: "Cage 1 is already booked" },
    };
    const close = vi.fn();

    const result = await closeAfterOk(async () => refusal, close)();
    expect(result).toBe(refusal);
    expect(close).not.toHaveBeenCalled();
  });

  it("a thrown error: close is NOT called, and the error is rethrown", async () => {
    const boom = new Error("network");
    const close = vi.fn();

    await expect(
      closeAfterOk(async (): Promise<Result> => {
        throw boom;
      }, close)(),
    ).rejects.toBe(boom);
    expect(close).not.toHaveBeenCalled();
  });
});
