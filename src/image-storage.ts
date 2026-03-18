/**
 * Image Storage Providers
 *
 * Abstraction for uploading campaign images to customer-controlled storage.
 * Customers host images on their own infrastructure so email opens
 * don't hit ScaleMargin's servers (privacy compliance).
 *
 * Supported providers:
 *   - s3    — AWS S3 (+ optional CloudFront CDN)
 *   - gcs   — Google Cloud Storage
 *   - local — Local filesystem (development only)
 *
 * To add a new provider (Azure Blob, Cloudinary, R2, etc.):
 *   1. Implement ImageStorageProvider
 *   2. Register in the factory switch below
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Storage as GCSStorage } from "@google-cloud/storage";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ImageStorageProvider {
  name: string;
  /** Upload image data and return a public URL. */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// AWS S3 Provider
// ---------------------------------------------------------------------------

export class S3ImageStorage implements ImageStorageProvider {
  name = "s3";
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private cdnBaseUrl?: string;

  constructor() {
    const bucket = process.env.IMAGE_S3_BUCKET;
    if (!bucket) {
      throw new Error("IMAGE_S3_BUCKET is required for S3 image storage");
    }

    this.bucket = bucket;
    this.prefix = process.env.IMAGE_S3_PREFIX || "campaign-images/";
    this.cdnBaseUrl = process.env.IMAGE_CDN_BASE_URL;
    this.client = new S3Client({
      region: process.env.IMAGE_S3_REGION || process.env.AWS_REGION || "ap-south-1",
    });
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const fullKey = `${this.prefix}${key}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000",
      })
    );

    if (this.cdnBaseUrl) {
      return `${this.cdnBaseUrl.replace(/\/$/, "")}/${fullKey}`;
    }
    return `https://${this.bucket}.s3.amazonaws.com/${fullKey}`;
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Storage Provider
// ---------------------------------------------------------------------------

export class GCSImageStorage implements ImageStorageProvider {
  name = "gcs";
  private client: GCSStorage;
  private bucket: string;
  private prefix: string;
  private cdnBaseUrl?: string;

  constructor() {
    const bucket = process.env.IMAGE_GCS_BUCKET;
    if (!bucket) {
      throw new Error("IMAGE_GCS_BUCKET is required for GCS image storage");
    }

    this.bucket = bucket;
    this.prefix = process.env.IMAGE_GCS_PREFIX || "campaign-images/";
    this.cdnBaseUrl = process.env.IMAGE_CDN_BASE_URL;

    // Support service account JSON via env var or Application Default Credentials
    const credentialsJson = process.env.IMAGE_GCS_CREDENTIALS_JSON;
    if (credentialsJson) {
      const trimmed = credentialsJson.trim();
      const stripped =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
          ? trimmed.slice(1, -1)
          : trimmed;

      const credentials = JSON.parse(stripped);
      this.client = new GCSStorage({
        projectId: process.env.IMAGE_GCS_PROJECT_ID || credentials.project_id,
        credentials,
      });
    } else {
      // Uses Application Default Credentials (ADC) — works on GCE/GKE/Cloud Run
      this.client = new GCSStorage({
        projectId: process.env.IMAGE_GCS_PROJECT_ID,
      });
    }
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const fullKey = `${this.prefix}${key}`;
    const file = this.client.bucket(this.bucket).file(fullKey);

    await file.save(data, {
      metadata: {
        contentType,
        cacheControl: "public, max-age=31536000",
      },
    });

    // If CDN is configured, assume it handles public access
    if (this.cdnBaseUrl) {
      return `${this.cdnBaseUrl.replace(/\/$/, "")}/${fullKey}`;
    }

    // Try to make the object publicly readable
    try {
      await file.makePublic();
      return `https://storage.googleapis.com/${this.bucket}/${fullKey}`;
    } catch {
      // Bucket uses uniform access — fall back to a signed URL (valid 7 days)
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      return signedUrl;
    }
  }
}

// ---------------------------------------------------------------------------
// Local File Storage (development only)
// ---------------------------------------------------------------------------

export class LocalImageStorage implements ImageStorageProvider {
  name = "local";
  private dir: string;
  private baseUrl: string;

  constructor() {
    this.dir = process.env.IMAGE_LOCAL_DIR || "./public/images";
    this.baseUrl =
      process.env.IMAGE_LOCAL_BASE_URL ||
      `http://localhost:${process.env.PORT || 3100}/images`;

    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    const filePath = join(this.dir, key);
    const dirPath = join(this.dir, key.split("/").slice(0, -1).join("/"));

    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    writeFileSync(filePath, data);
    return `${this.baseUrl}/${key}`;
  }
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

let _instance: ImageStorageProvider | null = null;

export function getImageStorage(): ImageStorageProvider | null {
  if (_instance) return _instance;

  const provider = process.env.IMAGE_STORAGE_PROVIDER;
  if (!provider) return null;

  switch (provider) {
    case "s3":
      _instance = new S3ImageStorage();
      break;
    case "gcs":
      _instance = new GCSImageStorage();
      break;
    case "local":
      _instance = new LocalImageStorage();
      break;
    default:
      console.warn(
        `[ImageStorage] Unknown provider: "${provider}". Supported: s3, gcs, local`
      );
      return null;
  }

  console.log(`[ImageStorage] Using provider: ${_instance.name}`);
  return _instance;
}
