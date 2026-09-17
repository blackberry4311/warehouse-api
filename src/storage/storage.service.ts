import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { extname } from 'path';
import { randomUUID } from 'crypto';

/** Default lifetime of a presigned URL, in seconds (5 minutes). */
export const DEFAULT_SIGNED_URL_TTL = 300;

/**
 * Generic, feature-agnostic wrapper over S3-compatible object storage (Railway
 * Buckets in prod; also works unchanged with R2 / MinIO / Garage / AWS S3 by
 * swapping the `S3_*` env vars). Deliberately knows nothing about credit/bills so
 * other features (e.g. shipment images) can reuse it — the caller owns the key
 * scheme and any DB bookkeeping.
 *
 * Config (see `.env.sample`): `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
 * `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  /** Client bound to the browser-reachable endpoint, used only to sign URLs. */
  private readonly signingClient: S3Client;
  private readonly bucket: string;
  /** Optional key prefix ("folder") prepended to every key, e.g. "dev" / "prod". */
  private readonly prefix: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const region = this.config.get<string>('S3_REGION') ?? 'auto';
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');
    const bucket = this.config.get<string>('S3_BUCKET');
    this.prefix = (this.config.get<string>('S3_PREFIX') ?? '').replace(/^\/+|\/+$/g, '');
    // Railway Buckets / MinIO / Garage require path-style addressing; default on.
    const forcePathStyle =
      (this.config.get<string>('S3_FORCE_PATH_STYLE') ?? 'true').toLowerCase() !== 'false';

    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      this.logger.warn(
        'Object storage is not fully configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY); uploads will fail until it is.',
      );
    }

    this.bucket = bucket ?? '';
    const credentials =
      accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
    this.client = new S3Client({ endpoint, region, forcePathStyle, credentials });

    // Presigned URLs are opened by the browser, so they must be signed against a
    // publicly reachable host. If S3_ENDPOINT is a private-network endpoint (e.g.
    // Railway internal), set S3_PUBLIC_ENDPOINT to the public one; the signature is
    // host-specific, so signing uses this separate client. Falls back to the main one.
    const publicEndpoint = this.config.get<string>('S3_PUBLIC_ENDPOINT');
    this.signingClient = publicEndpoint
      ? new S3Client({ endpoint: publicEndpoint, region, forcePathStyle, credentials })
      : this.client;
  }

  buildKey(pathPrefix: string, filename: string, label?: string): string {
    const ext = extname(filename ?? '').toLowerCase();
    const slug = label ? `${label.replace(/[^a-zA-Z0-9_-]+/g, '-')}-` : '';
    const base = `${pathPrefix.replace(/^\/+|\/+$/g, '')}/${slug}${randomUUID()}${ext}`;
    return this.prefix ? `${this.prefix}/${base}` : base;
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.assertConfigured();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  /**
   * A presigned GET URL the browser can open directly — no bytes flow through the
   * API. Access is time-boxed (`expiresIn` seconds); the object stays private. Signed
   * against the public endpoint (see constructor). Callers should still authorize
   * *issuing* the URL. Content-Disposition can be forced to make the browser download
   * rather than render inline.
   *
   * NOTE on `expiresIn`: standard AWS SigV4 caps this at 7 days (604800s). Railway
   * Buckets allow up to 90 days; other S3-compatible providers (R2 / MinIO / AWS)
   * reject anything over 7 days — keep it ≤ 7 days if you target those.
   */
  async getSignedUrl(
    key: string,
    expiresIn: number = DEFAULT_SIGNED_URL_TTL,
    downloadFilename?: string,
  ): Promise<string> {
    this.assertConfigured();
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: downloadFilename
        ? `attachment; filename="${downloadFilename}"`
        : undefined,
    });
    return getSignedUrl(this.signingClient, command, { expiresIn });
  }

  /** Delete an object. Missing keys are treated as already-gone (no throw). */
  async delete(key: string): Promise<void> {
    if (!key) return;
    this.assertConfigured();
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // A best-effort delete (e.g. cleanup, replace) shouldn't fail the request.
      this.logger.warn(`Failed to delete object ${key}: ${(err as Error).message}`);
    }
  }

  private assertConfigured(): void {
    if (!this.bucket) {
      throw new InternalServerErrorException('Object storage is not configured');
    }
  }
}
