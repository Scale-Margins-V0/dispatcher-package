import { getImageStorage } from "./storage.js";

export interface ImageMapping {
  originalUrl: string;
  hostedUrl: string;
}

interface DispatchImage {
  placeholder: string;
  url: string;
  raw_url: string;
  content_type: string;
  alt_text?: string;
  base64_data?: string;
}

export async function processImages(
  images: DispatchImage[],
  campaignId: string
): Promise<ImageMapping[]> {
  const storage = getImageStorage();

  if (!storage) {
    console.warn(
      "[Images] No IMAGE_STORAGE_PROVIDER configured — using original ScaleMargin image URLs. " +
        "For full privacy compliance, configure S3 image hosting."
    );
    return [];
  }

  const mappings: ImageMapping[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    try {
      let imageData: Buffer;
      let contentType = img.content_type || "image/png";

      if (img.base64_data) {
        imageData = Buffer.from(img.base64_data, "base64");
      } else {
        const response = await fetch(img.url);
        if (!response.ok) {
          console.warn(
            `[Images] Failed to download image ${i} from ${img.url}: ${response.status}`
          );
          continue;
        }
        imageData = Buffer.from(await response.arrayBuffer());
        contentType = response.headers.get("content-type") || contentType;
      }

      const ext = contentType.includes("png") ? "png" : "jpg";
      const key = `${campaignId}/${img.placeholder}.${ext}`;
      const hostedUrl = await storage.upload(key, imageData, contentType);

      mappings.push({
        originalUrl: img.raw_url || img.url,
        hostedUrl,
      });

      console.log(
        `[Images] ${img.placeholder}: ${img.url.slice(0, 60)}... → ${hostedUrl}`
      );
    } catch (error) {
      console.error(
        `[Images] Failed to process image ${img.placeholder}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  console.log(
    `[Images] Processed ${mappings.length}/${images.length} images for campaign ${campaignId}`
  );

  return mappings;
}
