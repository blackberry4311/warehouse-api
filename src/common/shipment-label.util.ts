/**
 * MIME types accepted for a shipment label image. Same set as top-up bills (a label
 * is usually a PNG/PDF from the carrier).
 */
export const LABEL_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

/**
 * Lifetime of a presigned label-view URL. 7 days is the standard S3 SigV4 max, so it
 * stays valid on R2 / MinIO / AWS as well as Railway Buckets; the FE re-requests one
 * when it expires. (Labels aren't age-expired like bills — they're deleted when their
 * shipment reaches DONE/CANCELLED — so there is no retention constant here.)
 */
export const LABEL_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
