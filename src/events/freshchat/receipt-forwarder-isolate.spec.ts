/**
 * One refused receipt must not sink the rest of its batch — but an endpoint
 * that refuses everything must not get every message dropped either.
 */
import { describe, expect, it } from "vitest";
import type { FreshchatReceipt } from "./adapter.js";
import { forwardFreshchatReceiptsIsolating, type ForwardResult } from "./receipt-forwarder.js";

const r = (id: string): FreshchatReceipt => ({ external_id: id, event: "read", occurred_at: "2026-09-30T12:00:00Z", provider: "freshchat" });
const ids = (list: FreshchatReceipt[]) => list.map((x) => x.external_id);

/** A fake ScaleMargin: refuses any batch holding one of `bad`, with `answer`. */
function scalemargin(bad: string[], answer: ForwardResult = { success: false, status: 404, error: '404: {"error":"Drip step not found"}' }) {
  const calls: string[][] = [];
  const forward = async (batch: FreshchatReceipt[]): Promise<ForwardResult> => {
    calls.push(ids(batch));
    return batch.some((x) => bad.includes(x.external_id)) ? answer : { success: true };
  };
  return { forward, calls };
}

describe("forwardFreshchatReceiptsIsolating", () => {
  it("delivers everything else and drops only the refused receipt, in order", async () => {
    const sm = scalemargin(["c"]);
    const out = await forwardFreshchatReceiptsIsolating(["a", "b", "c", "d", "e"].map(r), "s", sm.forward);
    expect(ids(out.accepted)).toEqual(["a", "b", "d", "e"]);
    expect(out.rejected.map((x) => x.receipt.external_id)).toEqual(["c"]);
    expect(out.failed).toEqual([]);
    expect(sm.calls.length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(5)));
  });

  it("a clean batch is one request", async () => {
    const sm = scalemargin([]);
    const out = await forwardFreshchatReceiptsIsolating(["a", "b"].map(r), "s", sm.forward);
    expect(ids(out.accepted)).toEqual(["a", "b"]);
    expect(sm.calls).toHaveLength(1);
  });

  it("a passing failure (5xx / network) is retried whole, never split", async () => {
    const sm = scalemargin(["a"], { success: false, error: "HTTP 503" });
    const out = await forwardFreshchatReceiptsIsolating(["a", "b", "c"].map(r), "s", sm.forward);
    expect(ids(out.failed)).toEqual(["a", "b", "c"]);
    expect(out.error).toBe("HTTP 503");
    expect(sm.calls).toHaveLength(1);
  });

  it("401/403 is a config problem — retried, never split or dropped", async () => {
    const sm = scalemargin(["a", "b"], { success: false, status: 401, error: "401: invalid signature" });
    const out = await forwardFreshchatReceiptsIsolating(["a", "b"].map(r), "s", sm.forward);
    expect(ids(out.failed)).toEqual(["a", "b"]);
    expect(out.rejected).toEqual([]);
    expect(sm.calls).toHaveLength(1);
  });

  it("everything refused with an unexplained 4xx (e.g. a wrong URL) is retried, not dropped", async () => {
    const sm = scalemargin(["a", "b"], { success: false, status: 404, error: "404: <html>Not Found</html>" });
    const out = await forwardFreshchatReceiptsIsolating(["a", "b"].map(r), "s", sm.forward);
    expect(out.rejected).toEqual([]);
    expect(ids(out.failed)).toEqual(["a", "b"]);
  });

  it("a refusal that names the receipt is dropped even when nothing else was accepted", async () => {
    const sm = scalemargin(["a"]);
    const out = await forwardFreshchatReceiptsIsolating([r("a")], "s", sm.forward);
    expect(out.rejected.map((x) => x.receipt.external_id)).toEqual(["a"]);
    expect(out.failed).toEqual([]);
  });

  it("a generic refusal is still per-receipt when others in the run were accepted", async () => {
    const sm = scalemargin(["b"], { success: false, status: 422, error: "422: invalid receipt" });
    const out = await forwardFreshchatReceiptsIsolating(["a", "b"].map(r), "s", sm.forward);
    expect(ids(out.accepted)).toEqual(["a"]);
    expect(out.rejected.map((x) => x.receipt.external_id)).toEqual(["b"]);
  });
});
