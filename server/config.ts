/**
 * ClearDoc System Configuration
 * All limits, timings, and storage parameters are environment-driven.
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Parses a positive integer env override. Invalid configuration must fail
 * loudly instead of silently disabling a resource limit (a NaN or <=0 limit
 * would de-facto disable the protection), so invalid values throw at boot.
 */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `[ClearDoc Config] Invalid ${name}="${raw}" — must be a positive integer. Refusing to start with an invalid resource limit.`
    );
  }
  return value;
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Storage & Limits
  MAX_FILE_SIZE_BYTES: parsePositiveInt(process.env.CLEARDOC_MAX_FILE_SIZE_BYTES, 31457280, 'CLEARDOC_MAX_FILE_SIZE_BYTES'), // 30 MB
  MAX_PAGE_COUNT: parsePositiveInt(process.env.CLEARDOC_MAX_PAGE_COUNT, 50, 'CLEARDOC_MAX_PAGE_COUNT'),
  // Decoded-pixel ceiling for raster images. Default is deployment-safe for
  // Render Free (512 MB). MEASURED on a fresh production instance:
  //   41 MP pipeline → ~802 MB peak RSS (old 50 MP default = predictable OOM)
  //   20 MP pipeline → ~522 MB peak RSS (still above the 512 MB envelope)
  //   16 MP pipeline → ~440 MB peak RSS (≈70 MB headroom — safe)
  //   12 MP pipeline → ~341 MB peak RSS
  // 16 MP is therefore the largest MEASURED-SAFE default; see
  // docs/deployment.md "Render Free". Override via CLEARDOC_MAX_IMAGE_PIXELS.
  MAX_IMAGE_PIXELS: parsePositiveInt(process.env.CLEARDOC_MAX_IMAGE_PIXELS, 16000000, 'CLEARDOC_MAX_IMAGE_PIXELS'),
  // PDF text-item ceiling (MEASURED, final validation pass 2026-10): render
  // memory on text-dense pages scales with per-page text OPERATIONS, not file
  // bytes or page count — a 368 KB / 1-page PDF with ~20,000 text items
  // measured 833 MB server peak RSS (over a 512 MB host) and ~85 s per render,
  // while 5,000–8,000 items measured 266–420 MB even cold. Byte size and page
  // count predict neither. Inspection stops early at this cumulative item
  // count and the upload is rejected honestly before any preview render.
  MAX_TEXT_ITEMS: parsePositiveInt(process.env.CLEARDOC_MAX_TEXT_ITEMS, 8000, 'CLEARDOC_MAX_TEXT_ITEMS'),
  // Per-page embedded-image pixel ceiling for PDFs. MEASURED (2026-10-02,
  // local event-loop instrumentation + live incident): a 6.6 MP image on one
  // page starves the Node event loop for 8–25 s per render locally and >15 s
  // on a 0.1-CPU Render Free instance — long enough for Render's HTTP health
  // checks to fail, which stops routing and severs in-flight requests. A
  // 1.4 MP/page document passed the same pipeline. File bytes do NOT predict
  // the stall (a 4 MB file with a 6.6 MP image stalled worse than a 19 MB file
  // with the same image). Inspection rejects any page over this limit at
  // upload, before any render. 2 MP ≈ 1.4× the largest MEASURED-safe value.
  // Raise only with more CPU per instance; see docs/deployment.md.
  MAX_PDF_IMAGE_PIXELS_PER_PAGE: parsePositiveInt(process.env.CLEARDOC_MAX_PDF_IMAGE_PIXELS_PER_PAGE, 2000000, 'CLEARDOC_MAX_PDF_IMAGE_PIXELS_PER_PAGE'),
  // Rendered-page pixel ceiling for PDF page previews/verification renders.
  // Mirrors MAX_IMAGE_PIXELS so a hostile page-size PDF (e.g. A0×10 ≈ 803 MP
  // at 150 dpi) fails with a deterministic JSON error instead of a native
  // canvas allocation failure (previously: silent skia crash → connection
  // reset). 16 MP render = 64 MB bitmap, well inside a 512 MB host.
  MAX_RENDER_PIXELS: parsePositiveInt(process.env.CLEARDOC_MAX_RENDER_PIXELS, 16000000, 'CLEARDOC_MAX_RENDER_PIXELS'),
  RETENTION_MS: parsePositiveInt(process.env.CLEARDOC_RETENTION_MS, 3600000, 'CLEARDOC_RETENTION_MS'), // 1 hour
  CLEANUP_INTERVAL_MS: parsePositiveInt(process.env.CLEARDOC_CLEANUP_INTERVAL_MS, 300000, 'CLEARDOC_CLEANUP_INTERVAL_MS'), // 5 min
  PROCESSING_DEADLINE_MS: parsePositiveInt(process.env.CLEARDOC_PROCESSING_DEADLINE_MS, 120000, 'CLEARDOC_PROCESSING_DEADLINE_MS'), // per-stage processing deadline

  // Processing admission gate: maximum simultaneous expensive processing
  // pipelines (PDF/raster removal + verification). Default 1: measured peak
  // RSS of a single 20 MP pipeline is a large fraction of a Render Free
  // instance's 512 MB, so concurrent pipelines multiply toward OOM. Excess
  // requests wait up to PROCESS_SLOT_WAIT_MS, then receive an honest 503.
  MAX_CONCURRENT_PROCESSES: parsePositiveInt(process.env.CLEARDOC_MAX_CONCURRENT_PROCESSES, 1, 'CLEARDOC_MAX_CONCURRENT_PROCESSES'),
  PROCESS_SLOT_WAIT_MS: parsePositiveInt(process.env.CLEARDOC_PROCESS_SLOT_WAIT_MS, 5000, 'CLEARDOC_PROCESS_SLOT_WAIT_MS'),

  // Bounded graceful-shutdown deadline for SIGTERM (Render sends it on
  // redeploy/restart). After this the process exits regardless of in-flight
  // work — restart semantics stay honest (in-flight jobs are lost, never
  // falsely reported as completed).
  SHUTDOWN_DEADLINE_MS: parsePositiveInt(process.env.CLEARDOC_SHUTDOWN_DEADLINE_MS, 10000, 'CLEARDOC_SHUTDOWN_DEADLINE_MS'),
  
  // Rendering DPI
  THUMBNAIL_DPI: 72,
  PREVIEW_DPI: parseInt(process.env.CLEARDOC_PREVIEW_DPI || '150', 10),
  VERIFICATION_DPI: parseInt(process.env.CLEARDOC_VERIFICATION_DPI || '150', 10),

  // Engine Versions
  ENGINE_VERSIONS: {
    detector: '1.0.0',
    pdfEngine: '1.0.0',
    restorationEngine: '1.0.0',
    verificationEngine: '1.0.0',
  },

  // Storage Paths
  // V1 (default): per-instance local temp dir.
  // V2 (opt-in): point CLEARDOC_SHARED_STORAGE_ROOT at a shared volume so all
  // instances serve the same session file tree. Requires CLEARDOC_SHARED_DB_PATH.
  BASE_STORAGE_DIR: path.resolve(
    process.env.CLEARDOC_SHARED_STORAGE_ROOT || path.join(process.cwd(), 'storage', 'temp')
  ),

  // Shared persistence (V2 multi-instance, fully opt-in)
  // When CLEARDOC_SHARED_DB_PATH is set, document/job/analysis/verification
  // metadata moves from in-memory Maps to a SQLite database (node:sqlite, WAL)
  // so multiple instances behind a load balancer share one source of truth.
  SHARED_DB_PATH: process.env.CLEARDOC_SHARED_DB_PATH || '',
  SHARED_STORAGE_ROOT: process.env.CLEARDOC_SHARED_STORAGE_ROOT || '',

  // Allowed Formats & MIME types
  SUPPORTED_MIME_TYPES: [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/tiff',
  ],

  // Verification Thresholds
  VISUAL_CHANGE_MAX_TOLERANCE_RATIO: 0.25, // If visual changes exceed 25% of page without full watermark coverage, trigger review
  UNEXPECTED_PIXEL_RADIUS_TOLERANCE: 12, // Pixel buffer around bounding box to tolerate anti-aliasing
};
