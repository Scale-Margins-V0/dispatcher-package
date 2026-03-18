/**
 * Image URL Rewriter
 *
 * Replaces ScaleMargin-hosted image URLs in campaign HTML
 * with customer-hosted URLs after images have been re-uploaded.
 */

import type { ImageMapping } from "./image-handler.js";

/**
 * Replace all ScaleMargin image URLs in the HTML with customer-hosted URLs.
 * Uses exact string matching (not regex) for reliability.
 */
export function rewriteImageUrls(
  html: string,
  mappings: ImageMapping[]
): string {
  let result = html;

  for (const { originalUrl, hostedUrl } of mappings) {
    // Replace all occurrences (same image might appear multiple times)
    result = result.replaceAll(originalUrl, hostedUrl);
  }

  return result;
}
