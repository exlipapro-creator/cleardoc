/**
 * ClearDoc Automatic Garbage Collection Worker
 * Periodically deletes expired temporary sessions and in-memory metadata.
 * Also exposes a startup sweep so artifacts orphaned by a restart (files
 * present on disk while the in-memory registry is empty) are not retained
 * beyond the retention policy.
 */
import { storageService } from './storage.js';
import { db } from './db.js';
import { CONFIG } from './config.js';

let intervalTimer: NodeJS.Timeout | null = null;

export function runCleanupCycle(): Promise<{ dbCleaned: number; storageCleaned: number }> {
  const dbCleaned = db.cleanupExpired();
  return storageService
    .cleanupExpiredSessions(CONFIG.RETENTION_MS)
    .then((storageCleaned) => ({ dbCleaned, storageCleaned }));
}

export function startCleanupWorker(): void {
  if (intervalTimer) return;

  // Startup sweep: on a fresh boot the in-memory registry is empty, so any
  // pre-existing storage/temp directories are by definition orphaned (their
  // metadata died with the previous process). Purge anything older than the
  // retention policy immediately rather than waiting for the first tick.
  runCleanupCycle()
    .then(({ dbCleaned, storageCleaned }) => {
      if (dbCleaned > 0 || storageCleaned > 0) {
        console.log(
          `[ClearDoc Cleanup] Startup sweep: purged ${dbCleaned} expired metadata records and ${storageCleaned} storage sessions.`
        );
      }
    })
    .catch((err) => {
      console.error('[ClearDoc Cleanup Error] Startup sweep failed:', err);
    });

  intervalTimer = setInterval(async () => {
    try {
      const { dbCleaned, storageCleaned } = await runCleanupCycle();
      if (dbCleaned > 0 || storageCleaned > 0) {
        console.log(`[ClearDoc Cleanup] Purged ${dbCleaned} expired metadata records and ${storageCleaned} storage sessions.`);
      }
    } catch (err) {
      console.error('[ClearDoc Cleanup Error]:', err);
    }
  }, CONFIG.CLEANUP_INTERVAL_MS);

  // Unref so server can cleanly terminate if needed
  if (intervalTimer.unref) {
    intervalTimer.unref();
  }
}

export function stopCleanupWorker(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
