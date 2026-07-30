import { describe, it, expect, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import type { ISdk } from "iii-sdk";

function fakeSdk(trigger: ISdk["trigger"]): ISdk {
  return { trigger } as unknown as ISdk;
}

describe("StateKV", () => {
  it("passes a timeoutMs shorter than the 180s worker default on every call", async () => {
    const trigger = vi.fn().mockResolvedValue(null);
    const kv = new StateKV(fakeSdk(trigger));

    await kv.get("scope", "key");
    await kv.set("scope", "key", { a: 1 });
    await kv.update("scope", "key", [{ type: "set", path: "/a", value: 1 }]);
    await kv.delete("scope", "key");
    await kv.list("scope");

    expect(trigger).toHaveBeenCalledTimes(5);
    for (const call of trigger.mock.calls) {
      const request = call[0] as { timeoutMs?: number };
      expect(request.timeoutMs).toBeDefined();
      expect(request.timeoutMs).toBeGreaterThan(0);
      // The whole point of #1127's fix: KV calls must not silently inherit
      // the 180s worker default sized for LLM-backed functions — a stuck
      // KV call should fail fast, well before that ceiling.
      expect(request.timeoutMs!).toBeLessThan(180_000);
    }
  });

  it("propagates a per-call timeout rejection to the caller (doesn't swallow it)", async () => {
    const trigger = vi.fn().mockRejectedValue(new Error("timeout"));
    const kv = new StateKV(fakeSdk(trigger));

    await expect(kv.get("scope", "key")).rejects.toThrow("timeout");
  });

  it("forwards the correct function_id and payload alongside the timeout", async () => {
    const trigger = vi.fn().mockResolvedValue(null);
    const kv = new StateKV(fakeSdk(trigger));

    await kv.get("mem:memories", "mem_123");

    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "state::get",
        payload: { scope: "mem:memories", key: "mem_123" },
        timeoutMs: expect.any(Number),
      }),
    );
  });
});
