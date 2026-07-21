import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherDb } from "../db/client.js";
import { resetDbForTests } from "../db/client.js";
import { queryLogs } from "../db/repos/logs.js";
import { createTestDb, destroyTestDb } from "../db/test-utils.js";
import { DbLogSink } from "./db-sink.js";

const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    level: 30,
    time: Date.now(),
    msg: "hello",
    ...overrides,
  });

let dbx: DispatcherDb;

beforeEach(async () => {
  dbx = await createTestDb();
});

afterEach(() => {
  destroyTestDb(dbx);
});

describe("DbLogSink", () => {
  it("persists parsed lines with level labels, context, and stacks", async () => {
    const sink = new DbLogSink();
    sink.write(
      line({
        level: 50,
        msg: "Campaign cmp_1 failed",
        campaign_id: "cmp_1",
        request_id: "req-1",
        component: "dispatch",
        err: { message: "boom", stack: "Error: boom\n  at x.ts:1" },
        channel: "email",
      })
    );
    await sink.flush();

    const page = await queryLogs({ limit: 10 });
    expect(page.logs).toHaveLength(1);
    const row = page.logs[0]!;
    expect(row.level).toBe("error");
    expect(row.message).toBe("Campaign cmp_1 failed");
    expect(row.campaign_id).toBe("cmp_1");
    expect(row.request_id).toBe("req-1");
    expect(row.component).toBe("dispatch");
    expect(row.stack).toContain("Error: boom");
    expect(row.context).toMatchObject({ channel: "email", error_message: "boom" });
  });

  it("flushes automatically at the batch threshold", async () => {
    const sink = new DbLogSink();
    for (let i = 0; i < 50; i++) sink.write(line({ msg: `m${i}` }));
    // batch flush is fired asynchronously at the threshold
    await sink.flush();
    await sink.flush();
    const page = await queryLogs({ limit: 100 });
    expect(page.logs.length).toBe(50);
  });

  it("drops malformed lines and survives DB unavailability without throwing", async () => {
    const sink = new DbLogSink();
    sink.write("not json{{");
    expect(sink.pendingCount()).toBe(0);

    destroyTestDb(dbx);
    resetDbForTests();
    sink.write(line());
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.pendingCount()).toBe(1); // buffered until a DB shows up

    dbx = await createTestDb();
    await sink.flush();
    const page = await queryLogs({ limit: 10 });
    expect(page.logs.length).toBe(1);
  });
});
