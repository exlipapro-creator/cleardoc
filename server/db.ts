/**
 * ClearDoc Metadata Store
 *
 * Facade over interchangeable persistence backends:
 *  - V1 default: per-process in-memory Maps (single instance only).
 *  - V2 opt-in:  shared SQLite database (WAL) so multiple instances behind a
 *                load balancer share one metadata source of truth.
 *
 * The public API (db.*) is identical in both modes; see server/persist.ts.
 * Shared mode requires BOTH CLEARDOC_SHARED_DB_PATH and
 * CLEARDOC_SHARED_STORAGE_ROOT — partial configuration fails fast at boot
 * rather than silently splitting metadata from files.
 */
import { CONFIG } from './config.js';
import { createBackend, MetadataBackend } from './persist.js';

if (Boolean(CONFIG.SHARED_DB_PATH) !== Boolean(CONFIG.SHARED_STORAGE_ROOT)) {
  throw new Error(
    '[ClearDoc Config] Shared persistence requires BOTH CLEARDOC_SHARED_DB_PATH and ' +
      'CLEARDOC_SHARED_STORAGE_ROOT — set both for multi-instance mode, or neither for ' +
      'single-instance mode. Refusing to start with only one configured.'
  );
}

export const db: MetadataBackend = createBackend(CONFIG.SHARED_DB_PATH);

export function getMetadataBackendKind(): 'memory' | 'sqlite' {
  return db.kind;
}
