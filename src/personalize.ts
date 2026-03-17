/**
 * Content Personalization
 *
 * Replaces ScaleMargin placeholders ({{first_name}}, {{company_name}}, etc.)
 * with actual PII from the customer's database.
 */

import type { UserRecord } from "./user-lookup.js";

const FALLBACKS: Record<string, string> = {
  first_name: "there",
  last_name: "",
  full_name: "there",
  company_name: "",
  email: "",
  unsubscribe_url: "#",
};

/**
 * Personalize content for a specific user.
 * Replaces all {{placeholder}} patterns with user data.
 */
export function personalize(content: string, user: UserRecord): string {
  let result = content;

  result = result.replace(
    /\{\{first_name\}\}/g,
    user.first_name || FALLBACKS.first_name
  );
  result = result.replace(
    /\{\{last_name\}\}/g,
    user.last_name || FALLBACKS.last_name
  );
  result = result.replace(
    /\{\{full_name\}\}/g,
    `${user.first_name || ""} ${user.last_name || ""}`.trim() ||
      FALLBACKS.full_name
  );
  result = result.replace(
    /\{\{company_name\}\}/g,
    user.company_name || FALLBACKS.company_name
  );
  result = result.replace(
    /\{\{email\}\}/g,
    user.email || FALLBACKS.email
  );

  // Unsubscribe URL — customer generates their own compliant link
  const unsubscribeUrl =
    process.env.UNSUBSCRIBE_URL_BASE ||
    "https://your-domain.com/unsubscribe";
  result = result.replace(
    /\{\{unsubscribe_url\}\}/g,
    `${unsubscribeUrl}?uid=${user.user_id}`
  );

  return result;
}
