/**
 * Human durations — `"5d 2h"`, `"2h"`, `"30d"` — parsed to milliseconds.
 *
 * Used by the message-id retention window, where the operator writes how long
 * ids are kept rather than a raw number of hours. Deliberately small and
 * strict: a retention setting that silently parses to the wrong number deletes
 * data early, and nobody notices until they go looking for it.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNIT_MS: Record<string, number> = {
  d: DAY_MS,
  h: HOUR_MS,
  m: MINUTE_MS,
};

/**
 * The retention sweep runs hourly, so a window shorter than an hour could not
 * be honoured anyway — rows would simply live until the next tick.
 */
export const MIN_DURATION_MS = HOUR_MS;

export class DurationParseError extends Error {}

/** `86_400_000` → `"1d"`, for echoing a parsed value back in logs. */
export function formatDuration(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const parts = [
    ...(days ? [`${days}d`] : []),
    ...(hours ? [`${hours}h`] : []),
    ...(minutes ? [`${minutes}m`] : []),
  ];
  return parts.length ? parts.join(" ") : "0h";
}

/**
 * Parse a duration string. Throws `DurationParseError` with a message naming
 * `settingName`, so the boot failure says which setting is wrong rather than
 * just that something is.
 *
 * Accepts `d`, `h` and `m`, in any order, with or without spaces. Minutes are
 * accepted only so that `"30m"` produces "below the minimum" instead of
 * "unparseable" — the more useful of the two errors.
 */
export function parseDuration(raw: string | undefined, settingName: string): number {
  const value = raw?.trim();
  if (!value) {
    throw new DurationParseError(
      `${settingName} is required — set it to how long to keep the data, e.g. "5d 2h". ` +
        `Minimum ${formatDuration(MIN_DURATION_MS)}.`
    );
  }

  // Every token must be <number><unit>; anything left over is a typo, not
  // something to ignore. `/g` with a global regex would skip junk silently.
  const tokens = value.toLowerCase().match(/[0-9]+\s*[a-z]+/g) ?? [];
  const consumed = tokens.join("").replace(/\s+/g, "");
  if (tokens.length === 0 || consumed !== value.toLowerCase().replace(/\s+/g, "")) {
    throw new DurationParseError(
      `${settingName}="${value}" is not a duration. Use a number and a unit — ` +
        `d (days), h (hours) or m (minutes) — for example "5d 2h", "12h" or "30d".`
    );
  }

  let total = 0;
  const seen = new Set<string>();
  for (const token of tokens) {
    const match = /^([0-9]+)\s*([a-z]+)$/.exec(token);
    // Guaranteed by the tokenizer above, but narrowing beats a non-null assertion.
    if (!match) {
      throw new DurationParseError(`${settingName}="${value}" is not a duration.`);
    }
    const [, amount, unit] = match;
    const unitMs = UNIT_MS[unit];
    if (unitMs === undefined) {
      throw new DurationParseError(
        `${settingName}="${value}" uses an unknown unit "${unit}". ` +
          `Supported units are d (days), h (hours) and m (minutes).`
      );
    }
    // "2h 3h" is far more likely to be a mistake than a request for five hours.
    if (seen.has(unit)) {
      throw new DurationParseError(
        `${settingName}="${value}" repeats the unit "${unit}" — write it once, e.g. "5d 2h".`
      );
    }
    seen.add(unit);
    total += Number(amount) * unitMs;
  }

  if (total < MIN_DURATION_MS) {
    throw new DurationParseError(
      `${settingName}="${value}" is ${formatDuration(total)}, below the minimum of ` +
        `${formatDuration(MIN_DURATION_MS)}. The retention sweep runs hourly, so a shorter ` +
        `window cannot be honoured.`
    );
  }

  return total;
}
