import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Hard cap for any uploaded file. Enforced at the transport (main.ts) and per-route. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** A single uploaded file, buffered into memory with its metadata. */
export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  size: number;
}

export interface ReadFileOptions {
  /** Allowed MIME types. Anything else is rejected with 400. */
  allowedMimeTypes: string[];
  /** Hard byte cap (belt-and-suspenders alongside the @fastify/multipart limit). */
  maxBytes: number;
}

/**
 * Read exactly one file from a multipart/form-data request and buffer it, feature-
 * agnostic so any upload route can reuse it. Enforces content-type and size, and
 * throws 400 if the request isn't multipart or carries no file part. Requires
 * `@fastify/multipart` registered (see `main.ts`).
 */
export async function readSingleUploadedFile(
  req: FastifyRequest,
  opts: ReadFileOptions,
): Promise<UploadedFile> {
  if (!req.isMultipart()) {
    throw new BadRequestException('Expected a multipart/form-data upload');
  }

  const part = await req.file();
  if (!part) throw new BadRequestException('No file was uploaded');

  if (!opts.allowedMimeTypes.includes(part.mimetype)) {
    throw new BadRequestException(
      `Unsupported file type "${part.mimetype}". Allowed: ${opts.allowedMimeTypes.join(', ')}`,
    );
  }

  const buffer = await part.toBuffer();

  // @fastify/multipart flags a truncated stream when the configured limit is hit.
  if (part.file.truncated || buffer.length > opts.maxBytes) {
    throw new PayloadTooLargeException(
      `File exceeds the maximum size of ${Math.floor(opts.maxBytes / (1024 * 1024))} MB`,
    );
  }

  return {
    buffer,
    filename: part.filename ?? 'upload',
    mimetype: part.mimetype,
    size: buffer.length,
  };
}
