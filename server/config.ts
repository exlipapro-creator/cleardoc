/**
 * ClearDoc System Configuration
 * All limits, timings, and storage parameters are environment-driven.
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Storage & Limits
  MAX_FILE_SIZE_BYTES: parseInt(process.env.CLEARDOC_MAX_FILE_SIZE_BYTES || '31457280', 10), // 30 MB
  MAX_PAGE_COUNT: parseInt(process.env.CLEARDOC_MAX_PAGE_COUNT || '50', 10),
  MAX_IMAGE_PIXELS: parseInt(process.env.CLEARDOC_MAX_IMAGE_PIXELS || '50000000', 10), // 50 MP decoded-pixel ceiling for raster images
  RETENTION_MS: parseInt(process.env.CLEARDOC_RETENTION_MS || '3600000', 10), // 1 hour
  CLEANUP_INTERVAL_MS: parseInt(process.env.CLEARDOC_CLEANUP_INTERVAL_MS || '300000', 10), // 5 min
  PROCESSING_DEADLINE_MS: parseInt(process.env.CLEARDOC_PROCESSING_DEADLINE_MS || '120000', 10), // per-stage processing deadline
  
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
