import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBuffer, EventEnvelope } from "./types.js";

export interface InMemoryBufferOptions {
  maxSize: number;
  onDropOldest?: () => void;
}

/**
 * FIFO ring: when full, drops oldest envelope before push.
 */
export class InMemoryEventBuffer implements EventBuffer {
  private readonly q: EventEnvelope[] = [];
  constructor(private readonly opts: InMemoryBufferOptions) {}

  push(envelope: EventEnvelope): void {
    while (this.q.length >= this.opts.maxSize) {
      this.q.shift();
      this.opts.onDropOldest?.();
    }
    this.q.push(envelope);
  }

  drain(max: number): EventEnvelope[] {
    const n = Math.min(max, this.q.length);
    return this.q.splice(0, n);
  }

  size(): number {
    return this.q.length;
  }
}

/**
 * Append-only JSONL file; drain reads first N lines and rewrites remainder.
 */
export class DiskEventBuffer implements EventBuffer {
  private readonly filePath: string;

  constructor(dir: string, filename = "pending.jsonl") {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, filename);
  }

  push(envelope: EventEnvelope): void {
    appendFileSync(this.filePath, `${JSON.stringify(envelope)}\n`, "utf-8");
  }

  drain(max: number): EventEnvelope[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      unlinkSync(this.filePath);
      return [];
    }
    const batchLines = lines.slice(0, max);
    const rest = lines.slice(max);
    const tmp = `${this.filePath}.tmp`;
    if (rest.length > 0) {
      writeFileSync(tmp, `${rest.join("\n")}\n`, "utf-8");
      renameSync(tmp, this.filePath);
    } else {
      if (existsSync(tmp)) unlinkSync(tmp);
      unlinkSync(this.filePath);
    }
    const out: EventEnvelope[] = [];
    for (const line of batchLines) {
      try {
        out.push(JSON.parse(line) as EventEnvelope);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }

  size(): number {
    if (!existsSync(this.filePath)) return 0;
    const raw = readFileSync(this.filePath, "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  }
}

export function createEventBuffer(opts: {
  kind: "memory" | "disk";
  memoryMaxSize?: number;
  diskDir?: string;
  onDropOldest?: () => void;
}): EventBuffer {
  if (opts.kind === "disk") {
    const dir = opts.diskDir ?? join(process.cwd(), "data", "event-buffer");
    return new DiskEventBuffer(dir);
  }
  return new InMemoryEventBuffer({
    maxSize: opts.memoryMaxSize ?? 10_000,
    onDropOldest: opts.onDropOldest,
  });
}
