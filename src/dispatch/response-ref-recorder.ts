/**
 * Saves values from API variable responses against the message they went out
 * with — an api variable's `save_response: { provider, paths }`.
 *
 * Same rules as MessageIdRecorder: rows collect in memory and are written once
 * at the end of the dispatch, and a failed write never fails a send.
 *
 * What is saved, per accepted message:
 *   - only for variables whose `save_response.provider` accepted the message
 *     (a failover to another provider saves nothing — its id is not the one
 *     the value is meant to be looked up by);
 *   - only values the API actually returned — a fallback is never saved, it
 *     would read as a real id;
 *   - only values that fit the column (191 chars) — a truncated id is wrong.
 */

import { insertApiResponseRefs } from "../db/repos/api-response-refs.js";
import { isDbInitialized } from "../db/state.js";
import { componentLogger } from "../logging/logger.js";
import { getPlaceholderRegistry } from "../user-lookup/config.js";
import type { ApiResponseRefRow } from "../db/schema/index.js";

const log = componentLogger("dispatch.response-refs");

const ID_MAX = 191;
const clamp = (value: string, max: number) => (value.length <= max ? value : value.slice(0, max));

export type ResponseSaver = { variable: string; provider: string; paths: string[] };

/** Enabled api variables that save part of their response. */
export function responseSavers(): ResponseSaver[] {
  return Object.entries(getPlaceholderRegistry()).flatMap(([name, entry]) =>
    entry.source === "api" && entry.api.save_response?.paths.length
      ? [{ variable: name, provider: entry.api.save_response.provider, paths: entry.api.save_response.paths }]
      : []
  );
}

/**
 * The values to save for one message: `{variable, path, value}` for each saved
 * path the recipient's resolution actually filled. `tooLong` names the ones
 * skipped for length (variable.path only — never the value).
 */
export function savedValues(
  savers: ResponseSaver[],
  provider: string,
  resolution: { values: Record<string, string>; fallbacks: string[] } | undefined
): { values: Array<{ variable: string; path: string; value: string }>; tooLong: string[] } {
  const values: Array<{ variable: string; path: string; value: string }> = [];
  const tooLong: string[] = [];
  if (!resolution) return { values, tooLong };
  const fellBack = new Set(resolution.fallbacks);
  for (const saver of savers) {
    if (saver.provider !== provider) continue;
    for (const path of saver.paths) {
      const token = `${saver.variable}.${path}`;
      const value = resolution.values[token];
      if (value === undefined || value === "" || fellBack.has(token)) continue;
      if (value.length > ID_MAX) {
        tooLong.push(token);
        continue;
      }
      values.push({ variable: saver.variable, path, value });
    }
  }
  return { values, tooLong };
}

export class ResponseRefRecorder {
  private readonly rows: ApiResponseRefRow[] = [];
  private readonly tooLong = new Set<string>();
  private readonly savers: ResponseSaver[];

  constructor(private readonly context: { campaignId: string; organizationId: string | null; channel: string }) {
    this.savers = isDbInitialized() ? responseSavers() : [];
  }

  /** False when nothing would be saved — no state database, or no variable saves a response. */
  get enabled(): boolean {
    return this.savers.length > 0;
  }

  /** Records the saved values for one message the provider accepted. */
  add(message: {
    provider: string;
    providerMessageId: string | null | undefined;
    userId: string;
    dispatchId?: string | null;
    senderId: string | null;
    templateName: string | null;
    resolution: { values: Record<string, string>; fallbacks: string[] } | undefined;
  }): void {
    if (!this.enabled) return;
    const id = message.providerMessageId?.trim();
    if (!id) return;
    const { values, tooLong } = savedValues(this.savers, message.provider, message.resolution);
    for (const t of tooLong) this.tooLong.add(t);
    const sentAt = new Date();
    for (const v of values) {
      this.rows.push({
        id: crypto.randomUUID(),
        provider: clamp(message.provider, 32),
        provider_message_id: clamp(id, ID_MAX),
        channel: clamp(this.context.channel, 16),
        user_id: clamp(message.userId, ID_MAX),
        organization_id: this.context.organizationId ? clamp(this.context.organizationId, ID_MAX) : null,
        campaign_id: clamp(this.context.campaignId, ID_MAX),
        dispatch_id: message.dispatchId ? clamp(message.dispatchId, ID_MAX) : null,
        template_name: message.templateName ? clamp(message.templateName, ID_MAX) : null,
        sender_id: message.senderId ? clamp(message.senderId, ID_MAX) : null,
        variable_name: clamp(v.variable, ID_MAX),
        path: clamp(v.path, ID_MAX),
        value: v.value,
        sent_at: sentAt,
      });
    }
  }

  /** Fire-and-forget by design — awaiting would put bookkeeping on the send path. */
  flush(): void {
    if (this.tooLong.size > 0) {
      log.warn(
        { paths: [...this.tooLong] },
        `Not saved: response value longer than ${ID_MAX} characters (${[...this.tooLong].join(", ")})`
      );
      this.tooLong.clear();
    }
    if (this.rows.length === 0) return;
    const batch = this.rows.splice(0, this.rows.length);
    void insertApiResponseRefs(batch).catch((error: unknown) => {
      log.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Failed to persist ${batch.length} saved response value(s)`
      );
    });
  }
}
