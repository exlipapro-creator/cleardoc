# ClearDoc Deployment

## Supported topologies

### Single instance (default)

One server process, in-memory metadata, local temp files. No configuration
needed.

### Two or more instances behind a load balancer (opt-in V2)

All instances must share:

```bash
CLEARDOC_SHARED_DB_PATH=/var/lib/cleardoc/shared.db      # SQLite (node:sqlite, WAL)
CLEARDOC_SHARED_STORAGE_ROOT=/var/lib/cleardoc/storage   # shared volume for session files
```

- Both variables are required together; setting only one fails fast at boot.
- The SQLite DB file must live on storage with correct POSIX locking: a local
  disk or network **block** volume. NFS/SMB/general network file shares are
  explicitly unsupported for the DB. If you containerize: keep the DB on the
  instance's local disk or an RWO block volume, and use a shared RWX volume
  only for `CLEARDOC_SHARED_STORAGE_ROOT`.
- Session affinity is NOT required; any instance can serve any request
  (verified by E2E phase 4, checks M01–M14, including a cross-instance
  double-process race that yields exactly one 200 + one 409).
- GC runs independently in every instance against the shared DB and storage —
  it is idempotent and safe to run concurrently.
- Retention semantics are unchanged: 1 h temp files, purge on expiry.

## Deploying to Render Free (V1 target)

ClearDoc is certified for a single **Render Free web service** serving the SPA
and API from one process. This is the recommended V1 deployment.

### Service configuration

```text
Runtime:             Node
Build command:       npm ci && npm run build
Start command:       npm run start          (node dist/server.js)
Health check path:   /health
Env vars:            NODE_ENV=production
Disk:                none (ephemeral — this is the intended model)
```

`PORT` is supplied by Render and already honored. The server binds `0.0.0.0`.
No secrets are required. SQLite is intentionally **disabled** for V1: the
single-instance ephemeral model needs no shared metadata store, and Render
Free has no persistent disk to host one.

### Render Free constraints and how ClearDoc relates to them

- **Ephemeral filesystem.** Uploads, outputs and previews live in
  `storage/temp` for at most 1 hour (GC) and vanish on restart, redeploy, or
  idle spin-down. This *matches* the privacy model: documents are meant to be
  destroyed, never retained.
- **Idle spin-down.** After 15 minutes without inbound traffic the instance
  sleeps; the next request waits roughly one minute while it wakes. The
  frontend detects genuine unavailability (502/503/network errors), probes
  `/health` on a bounded retry cadence, shows a real "waking up" state, and
  retries the request once the service answers. There is no keep-alive ping,
  self-ping, or fake traffic anywhere in the codebase — by design.
- **Memory envelope (512 MB).** The raster ceiling defaults to
  `CLEARDOC_MAX_IMAGE_PIXELS=16000000` (16 MP) — the largest **measured-safe**
  value: 20 MP measured ~522 MB peak RSS (over the envelope) and 41 MP
  measured ~802 MB on a fresh production instance; 16 MP measured ~440 MB.
  Over-limit images are rejected at ingest with `413 IMAGE_TOO_LARGE` before
  any memory-intensive processing begins.
- **Single instance.** Processing is admission-gated at
  `CLEARDOC_MAX_CONCURRENT_PROCESSES=1` simultaneous pipeline. Excess
  requests wait up to `CLEARDOC_PROCESS_SLOT_WAIT_MS` (5 s), then receive
  `503 SERVICE_BUSY` with `Retry-After`. This prevents concurrent pipelines
  from multiplying peak memory on a small instance.
- **Restarts at any time.** On SIGTERM the server stops accepting work,
  closes idle connections, runs one final GC pass, and exits within a bounded
  deadline (`CLEARDOC_SHUTDOWN_DEADLINE_MS`). In-flight jobs are lost
  **honestly**: metadata is ephemeral, so stale sessions get deterministic
  404s and the UI surfaces `SESSION_EXPIRED` — never a false `COMPLETED`,
  never another user's data.

### External monitoring (UptimeRobot)

Create one HTTP(s) monitor against `https://<production-domain>/health`
expecting HTTP 200 (5-minute interval on the free plan). `/health` is a
liveness/readiness probe: it performs no document processing, allocates no
large buffers, and exposes only version strings, backend kind, and pipeline
counts — no secrets, paths, or user data.

**Monitoring is not an application dependency.** ClearDoc works correctly with
the monitor removed, including after a cold start. If the monitor's regular
5-minute visits happen to reduce idle spin-downs, that is a property of the
external monitoring arrangement, not application logic; the codebase contains
no sleep-defeating behavior and must never gain any.

### Honest expectations

Do not expect zero-downtime deploys, persistent storage, or guaranteed
always-on availability on the Free plan. Documents must be downloaded promptly
(outputs share the 1-hour ephemeral lifecycle). If usage outgrows the Free
envelope, the migration path is: upgrade the service's compute plan first
(more CPU/RAM, no spin-down), raise `CLEARDOC_MAX_IMAGE_PIXELS` to match the
new memory, and only consider multi-instance shared mode (SQLite + shared
volume) on hosting that provides a real block/shared volume.

## Build & run

```bash
npm ci                 # reproducible install from package-lock.json
npm run build          # frontend (vite) → dist/index.html + dist/assets
                       # server bundle (esbuild) → dist/server.js
NODE_ENV=production PORT=3000 node dist/server.js
```

The production server serves the SPA from `dist/` and the API under `/api/`.
There is no separate worker process: processing happens in-process behind the
HTTP handlers, bounded by the 120 s per-stage deadline.

## Health checks

- `GET /health` → 200 `{status:"ok", engines:{...}}` — liveness.
- `GET /ready` → 200 `{status:"ready"}` when the storage root is writable,
  503 otherwise — wire this into your orchestrator's readiness gate.

## Environment variables (all optional; see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` serves built `dist/` |
| `CLEARDOC_MAX_FILE_SIZE_BYTES` | `31457280` | Upload size limit |
| `CLEARDOC_MAX_PAGE_COUNT` | `50` | PDF page limit |
| `CLEARDOC_MAX_IMAGE_PIXELS` | `16000000` | Decoded-pixel ceiling for raster images (16 MP = largest measured-safe value for 512 MB Render Free; 20 MP measured ~522 MB peak) |
| `CLEARDOC_RETENTION_MS` | `3600000` | Temp-file retention |
| `CLEARDOC_CLEANUP_INTERVAL_MS` | `300000` | GC cycle interval |
| `CLEARDOC_PROCESSING_DEADLINE_MS` | `120000` | Per-stage processing deadline |
| `CLEARDOC_MAX_CONCURRENT_PROCESSES` | `1` | Max simultaneous processing pipelines (memory-safety admission gate) |
| `CLEARDOC_PROCESS_SLOT_WAIT_MS` | `5000` | How long an excess process request waits before 503 SERVICE_BUSY |
| `CLEARDOC_SHUTDOWN_DEADLINE_MS` | `10000` | Bounded graceful-shutdown window on SIGTERM |
| `CLEARDOC_PREVIEW_DPI` / `CLEARDOC_VERIFICATION_DPI` | `150` | Rasterization resolutions |

No secrets are required; ClearDoc performs no outbound calls.

## Reverse proxy

Terminate TLS at the proxy (nginx/Caddy/ALB). Forward `/` to the Node server.
HSTS belongs at the proxy layer. Keep client body size ≥ the configured upload
limit (e.g. nginx `client_max_body_size 32m`).

## Process supervision

Run under systemd / Windows Service / container runtime with restart-on-failure.
On restart: in-flight jobs are lost (documents disappear honestly — no false
`COMPLETED`); files orphaned by the crash are purged by the GC once retention
elapses (startup sweep verified).

## Example systemd unit

```ini
[Unit]
Description=ClearDoc
After=network.target

[Service]
WorkingDirectory=/opt/cleardoc
ExecStart=/usr/bin/node dist/server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Restart=on-failure
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/cleardoc/storage

[Install]
WantedBy=multi-user.target
```

## Not provided

- Docker images / compose files (none exist in the repo — do not assume one).
- More than shared-file SQLite: no Postgres/Redis queue, no object storage.
- Metrics/tracing endpoints; logs are structured console output only.
- Active-active across machines with SQLite over NFS — explicitly unsupported;
  keep `CLEARDOC_SHARED_DB_PATH` on local/block storage.
