/**
 * ClearDoc Automatic Garbage Collection Worker
 * Periodically deletes expired temporary sessions and in-memory metadata.
 */
import { storageService } from './storage.js';
import { db } from './db.js';
import { CONFIG } from './config.js';

let intervalTimer: NodeJS.Timeout | null = null;

export function startCleanupWorker(): void {
  if (intervalTimer) return;

  intervalTimer = setInterval(async () => {
    try {
      const dbCleaned = db.cleanupExpired();
      const storageCleaned = await storageService.cleanupExpiredSessions(CONFIG.RETENTION_MS);
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
