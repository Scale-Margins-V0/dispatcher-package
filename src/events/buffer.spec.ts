import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiskEventBuffer, InMemoryEventBuffer } from "./buffer.js";
import type { EventEnvelope } from "./types.js";

function env(): EventEnvelope {
  return {
    callbackUrl: "http://127.0.0.1:1/cb",
    event: {
      campaign_id: "c",
      user_id: "u",
      organization_id: "o",
      channel: "email",
      event: "delivered",
      provider: "sendgrid",
      provider_message_id: "m",
      occurred_at: new Date().toISOString(),
    },
  };
}

describe("InMemoryEventBuffer", () => {
  it("drops oldest when over maxSize and invokes callback", () => {
    const onDrop = vi.fn();
    const b = new InMemoryEventBuffer({ maxSize: 2, onDropOldest: onDrop });
    b.push(env());
    b.push(env());
    b.push(env());
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(b.size()).toBe(2);
    const drained = b.drain(10);
    expect(drained).toHaveLength(2);
  });

  it("drain respects max", () => {
    const b = new InMemoryEventBuffer({ maxSize: 10 });
    b.push(env());
    b.push(env());
    expect(b.drain(1)).toHaveLength(1);
    expect(b.size()).toBe(1);
  });
});

describe("DiskEventBuffer", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("append and drain leaves remainder", () => {
    dir = mkdtempSync(join(tmpdir(), "evtbuf-"));
    const b = new DiskEventBuffer(dir);
    b.push(env());
    b.push(env());
    b.push(env());
    expect(b.size()).toBe(3);
    const first = b.drain(2);
    expect(first).toHaveLength(2);
    expect(b.size()).toBe(1);
    const second = b.drain(10);
    expect(second).toHaveLength(1);
    expect(b.size()).toBe(0);
  });
});
