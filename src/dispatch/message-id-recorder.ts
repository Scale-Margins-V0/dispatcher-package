/**
 * Collects provider message ids during a dispatch and writes them once, at the
 * end, in chunks.
 *
 * Same two rules as SendLogRecorder, for the same reasons:
 *
 *   1. **Never write inside the send loop.** Rows accumulate in memory and
 *      flush once, so a 50,000-recipient campaign is 250 statements rather
 *      than 50,000 round trips.
 *   2. **Never fail a send for bookkeeping.** flush() swallows and logs. A
 *      message that went out must not be reported as failed because an insert
 *      did not land.
 *
 * Only accepted sends are recorded. A send the provider rejected has no
 * message id to look up, and a row with a null id would be noise in a table
 * whose entire purpose is "here are the ids we were given".
 */

import { insertProviderMessageIds } from "../db/repos/provider-message-ids.js";
import { isDbInitialized } from "../db/state.js";
import { componentLogger } from "../logging/logger.js";
import type { ProviderMessageIdRow } from "../db/schema/index.js";

const log = componentLogger("dispatch.message-ids");

/** provider_message_id and user_id are varchar(191); provider is varchar(32). */
const ID_MAX = 191;
const PROVIDER_MAX = 32;

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

export class MessageIdRecorder {
  private readonly rows: ProviderMessageIdRow[] = [];

  /** False when there is no state database, so callers can skip the work. */
  get enabled(): boolean {
    return isDbInitialized();
  }

  /** Records an accepted send. A missing or blank id is ignored. */
  add(
    provider: string,
    providerMessageId: string | null | undefined,
    userId: string
  ): void {
    if (!this.enabled) return;
    const id = providerMessageId?.trim();
    if (!id) return;

    this.rows.push({
      id: crypto.randomUUID(),
      provider: clamp(provider, PROVIDER_MAX),
      provider_message_id: clamp(id, ID_MAX),
      user_id: clamp(userId, ID_MAX),
      sent_at: new Date(),
    });
  }

  /** Fire-and-forget by design — awaiting would put bookkeeping on the send path. */
  flush(): void {
    if (this.rows.length === 0) return;
    const batch = this.rows.splice(0, this.rows.length);
    void insertProviderMessageIds(batch).catch((error: unknown) => {
      log.warn(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Failed to persist ${batch.length} provider message id(s)`
      );
    });
  }
}
