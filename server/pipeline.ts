/**
 * ClearDoc Processing Pipeline Gate
 *
 * Processing (removal + verification) is the only stage that allocates
 * measurably large buffers (decoded raster pixels, page renders, diff frames).
 * On a memory-constrained host (Render Free, 512 MB) two concurrent pipelines
 * can multiply that allocation toward OOM, so expensive work is admitted
 * through a tiny in-process counting semaphore:
 *
 *   - MAX_CONCURRENT_PROCESSES slots (default 1 — see config.ts for the
 *     measured-memory rationale),
 *   - excess requests wait up to PROCESS_SLOT_WAIT_MS for a free slot, then
 *     receive an honest, deterministic rejection (never a hang),
 *   - slot ownership is TRANSFERRED directly to the next waiter at release
 *     (no decrement-then-reincrement window), so the gate can never
 *     over-admit, and release happens exactly once on success, failure,
 *     throw, or timeout — it cannot permanently deadlock the processor.
 *
 * This is deliberately NOT a distributed queue: ClearDoc V1 is a single
 * in-process server (Render Free single instance), so an in-process gate
 * correctly reflects the actual concurrency domain.
 */

import { CONFIG } from './config.js';

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'TIMEOUT' };

export class PipelineGate {
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly waitMs: number
  ) {}

  /**
   * Acquires a processing slot, waiting up to the configured wait window for
   * one to free. Resolve value is `{ ok: true, release }` or a deterministic
   * `{ ok: false, reason: 'TIMEOUT' }`. `release()` is idempotent and hands
   * the slot directly to the next waiter when one exists.
   */
  async acquire(): Promise<AcquireResult> {
    // Fast path: free slot AND no queued waiters (FIFO fairness — a caller
    // never jumps the queue even when a slot is momentarily free).
    if (this.running < this.maxConcurrent && this.waiters.length === 0) {
      this.running++;
      return { ok: true, release: this.makeRelease() };
    }

    const gotSlot = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, this.waitMs);
      if (timer.unref) timer.unref();

      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });

    if (!gotSlot) return { ok: false, reason: 'TIMEOUT' };
    // Ownership was transferred by the previous holder's release(): running
    // was never decremented for this hand-off, so do NOT increment here.
    return { ok: true, release: this.makeRelease() };
  }

  /** Diagnostics only (no secrets, no user data). */
  public snapshot(): { running: number; waiting: number; limit: number } {
    return { running: this.running, waiting: this.waiters.length, limit: this.maxConcurrent };
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // direct ownership transfer: running count stays as-is
      } else {
        this.running--;
      }
    };
  }
}

// Single global gate for the process. Defaults come from validated config.
export const pipelineGate = new PipelineGate(
  CONFIG.MAX_CONCURRENT_PROCESSES,
  CONFIG.PROCESS_SLOT_WAIT_MS
);
