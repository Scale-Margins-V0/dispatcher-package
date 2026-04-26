import type { ImageMapping } from "./handler.js";

export function rewriteImageUrls(
  html: string,
  mappings: ImageMapping[]
): string {
  let result = html;

  for (const { originalUrl, hostedUrl } of mappings) {
    result = result.replaceAll(originalUrl, hostedUrl);
  }

  return result;
}
