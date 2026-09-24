/**
 * Duration parsing for the message-id retention window.
 *
 * This value decides when customer-adjacent data is deleted, so the tests lean
 * on the failure cases: a typo that parses to something plausible-but-wrong
 * deletes data early, and nobody finds out until they go looking for an id
 * that should still have been there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DurationParseError, formatDuration, parseDuration } from "./duration.js";
import {
  MESSAGE_ID_TTL_SETTING,
  messageIdTtlMs,
  resetMessageIdTtlForTests,
} from "./message-id-ttl.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

afterEach(() => {
  resetMessageIdTtlForTests();
  vi.unstubAllEnvs();
});

describe("parsing", () => {
  it.each([
    ["1h", HOUR],
    ["2h", 2 * HOUR],
    ["5d", 5 * DAY],
    ["5d 2h", 5 * DAY + 2 * HOUR],
    ["5d2h", 5 * DAY + 2 * HOUR],
    ["  5d   2h  ", 5 * DAY + 2 * HOUR],
    ["5D 2H", 5 * DAY + 2 * HOUR],
    ["30d", 30 * DAY],
    ["1d 30m", DAY + 30 * 60 * 1000],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input, "ttl")).toBe(expected);
  });

  it("does not care about unit order", () => {
    expect(parseDuration("2h 5d", "ttl")).toBe(parseDuration("5d 2h", "ttl"));
  });
});

describe("rejection", () => {
  // The whole point of being mandatory.
  it.each([undefined, "", "   "])("rejects a missing value (%s)", (input) => {
    expect(() => parseDuration(input, "ttl")).toThrow(DurationParseError);
    expect(() => parseDuration(input, "ttl")).toThrow(/required/);
  });

  // A bare number is the likeliest mistake. Guessing a unit for it would mean
  // "2" silently becoming 2ms, 2h or 2d depending on what we felt like.
  it.each(["2", "soon", "5 days", "d", "-2h", "2.5h"])(
    "rejects %s rather than guessing",
    (input) => {
      expect(() => parseDuration(input, "ttl")).toThrow(DurationParseError);
    }
  );

  // "5d x" must not quietly parse as 5 days.
  it("rejects trailing junk instead of ignoring it", () => {
    expect(() => parseDuration("5d banana", "ttl")).toThrow(DurationParseError);
    expect(() => parseDuration("5d;DROP TABLE", "ttl")).toThrow(DurationParseError);
  });

  it("rejects an unknown unit and names it", () => {
    expect(() => parseDuration("5y", "ttl")).toThrow(/unknown unit "y"/);
  });

  it("rejects a repeated unit — far more likely a mistake than intent", () => {
    expect(() => parseDuration("2h 3h", "ttl")).toThrow(/repeats the unit/);
  });

  it("names the setting in every error, so the fix is obvious", () => {
    expect(() => parseDuration("nope", "retention.message_id_ttl")).toThrow(
      /retention\.message_id_ttl/
    );
  });
});

describe("the one-hour floor", () => {
  it("accepts exactly 1h", () => {
    expect(parseDuration("1h", "ttl")).toBe(HOUR);
  });

  // The sweep runs hourly, so anything shorter could not be honoured. Minutes
  // are parsed at all only so this error is reachable instead of "unparseable".
  it.each(["30m", "1m", "59m"])("rejects %s, below the floor", (input) => {
    expect(() => parseDuration(input, "ttl")).toThrow(/below the minimum/);
  });

  it("explains why, rather than just refusing", () => {
    expect(() => parseDuration("30m", "ttl")).toThrow(/sweep runs hourly/);
  });
});

describe("formatDuration", () => {
  it.each([
    [HOUR, "1h"],
    [5 * DAY + 2 * HOUR, "5d 2h"],
    [30 * DAY, "30d"],
    [0, "0h"],
  ])("renders %i as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("round-trips through parseDuration", () => {
    for (const input of ["1h", "12h", "5d", "5d 2h", "30d"]) {
      expect(formatDuration(parseDuration(input, "ttl"))).toBe(input);
    }
  });
});

describe("the message-id TTL setting", () => {
  it("reads DISPATCHER_MESSAGE_ID_TTL", () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "5d 2h");
    expect(messageIdTtlMs()).toBe(5 * DAY + 2 * HOUR);
  });

  // No default: a guess here is either too short (ids gone before use) or
  // effectively forever.
  it("throws when unset — there is deliberately no default", () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "");
    expect(() => messageIdTtlMs()).toThrow(DurationParseError);
  });

  it("names both the yaml key and the variable, since either may be in use", () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "");
    expect(() => messageIdTtlMs()).toThrow(/retention\.message_id_ttl/);
    resetMessageIdTtlForTests();
    expect(() => messageIdTtlMs()).toThrow(/DISPATCHER_MESSAGE_ID_TTL/);
  });

  it("caches, so a sweep does not re-parse on every tick", () => {
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "2h");
    expect(messageIdTtlMs()).toBe(2 * HOUR);
    vi.stubEnv(MESSAGE_ID_TTL_SETTING, "30d");
    expect(messageIdTtlMs()).toBe(2 * HOUR);
  });
});
