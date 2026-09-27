/**
 * What a lookup is FOR decides what it asks for and what it requires.
 *
 * An email send needs an address and never a phone number; a WhatsApp send
 * needs a phone number and never an address. Asking for both hands us personal
 * data we have no use for — the reason a client picks network mode in the first
 * place — and requiring `email` on a WhatsApp lookup silently drops everyone
 * who only has a phone.
 *
 * The lookup returns contact details and nothing else. Personalization comes
 * from variables; in database mode those may read extra columns of the source
 * view, which the SQL adapter adds on top (see field-refs.ts).
 */

export type LookupChannel = "email" | "whatsapp";

/**
 * The logical field(s) that make a recipient reachable on each channel.
 * `phone_no` is the older name for `phone`; resolveRecipientPhone reads both.
 */
const CONTACT_FIELDS: Record<LookupChannel, readonly string[]> = {
  email: ["email"],
  whatsapp: ["phone", "phone_no"],
};

/** Every contact field name, across channels. */
export const CONTACT_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.values(CONTACT_FIELDS).flat()
);

/** Just this channel's contact field(s) from the fields map. */
export function fieldsForChannel(
  fieldMap: Record<string, string>,
  channel: LookupChannel
): Record<string, string> {
  const own = CONTACT_FIELDS[channel];
  return Object.fromEntries(
    Object.entries(fieldMap).filter(([logical]) => own.includes(logical))
  );
}

/** True when the record carries a non-empty contact field for the channel. */
export function isReachable(
  fields: Record<string, string | undefined>,
  channel: LookupChannel
): boolean {
  return CONTACT_FIELDS[channel].some((f) => Boolean(fields[f]));
}
