/**
 * ClearDoc frontend API client.
 *
 * Wraps fetch with the three failure modes a Render Free deployment actually
 * produces:
 *
 *  1. Service sleeping / restarting → network error, 502 or 503 from the
 *     platform edge. We probe /health on a bounded retry cadence and surface
 *     a genuine "waking up" state — never a fake progress bar, never an
 *     arbitrary delay when the service is actually back.
 *  2. Requests that can legitimately take a while (processing) use an
 *     abortable timeout and map to an honest error instead of hanging the UI.
 *  3. Deterministic session-expiry mapping: after a restart or idle wipe,
 *     a stale session id must surface as SESSION_EXPIRED, never as a
 *     generic failure or an infinite loading state.
 *
 * No fake loading, no artificial setTimeout delays: every wait here is a
 * bounded retry against the real service, and the UI communicates the actual
 * observed state.
 */

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const WAKE_PROBE_INTERVAL_MS = 3000;
const WAKE_MAX_WAIT_MS = 90000; // Render wake ≈ 1 min; stay bounded but patient
const DEFAULT_TIMEOUT_MS = 15000;

/** Raw request with an AbortController timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wake notification: lets the UI show a genuine "service is waking up" state
 * while waitForWake() is probing, and clear it when the request settles.
 */
type WakeListener = () => void;
const wakeListeners = new Set<WakeListener>();

export function onServiceWaking(fn: WakeListener): () => void {
  wakeListeners.add(fn);
  return () => {
    wakeListeners.delete(fn);
  };
}

function notifyWaking(): void {
  wakeListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must never break the retry path */
    }
  });
}

/**
 * Probes /health on a bounded cadence while the edge returns 502/503 or the
 * connection fails (Render spin-down/restart). Resolves as soon as the app
 * itself answers 200 — not merely the platform.
 */
async function waitForWake(): Promise<void> {
  notifyWaking();
  const deadline = Date.now() + WAKE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout('/health', { method: 'GET' }, 5000);
      if (res.ok) return;
    } catch {
      /* still down — keep probing */
    }
    await new Promise((r) => setTimeout(r, WAKE_PROBE_INTERVAL_MS));
  }
  throw new ApiError(
    'SERVICE_UNAVAILABLE',
    'ClearDoc is temporarily unavailable. Please try again.'
  );
}

/**
 * Single attempt of an API call. Network failures and platform 502/503 are
 * classified as SERVICE_UNAVAILABLE so callers can offer a real retry.
 */
async function attemptRequest(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, init, timeoutMs);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ApiError('REQUEST_TIMEOUT', 'The request timed out. Please try again.');
    }
    throw new ApiError('SERVICE_UNAVAILABLE', 'Cannot reach ClearDoc. Please try again.');
  }
  if (res.status === 502 || res.status === 503) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'ClearDoc is temporarily unavailable. Please try again.');
  }
  return res;
}

/**
 * Performs an API request. On SERVICE_UNAVAILABLE it first probes /health on
 * a bounded cadence (genuine wake detection); if the service comes back the
 * request is retried once; if not, the honest unavailable error propagates.
 */
export async function apiRequest(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  try {
    return await attemptRequest(url, init, timeoutMs);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SERVICE_UNAVAILABLE') {
      await waitForWake();
      return attemptRequest(url, init, timeoutMs);
    }
    throw err;
  }
}

/**
 * Standard JSON envelope handling shared by all callers. Maps deterministic
 * server codes to stable frontend error classes.
 */
export async function parseResponse<T = any>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const code = body?.error?.code || `HTTP_${res.status}`;
    const message = body?.error?.message || 'Unexpected server error.';
    throw new ApiError(code, message, res.status);
  }
  return body as T;
}

/** True when the server no longer knows this session (restart / idle wipe). */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SESSION_EXPIRED';
}

/** True when processing capacity is temporarily exhausted (gate 503). */
export function isServiceBusy(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SERVICE_BUSY';
}
