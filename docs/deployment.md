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
| `CLEARDOC_MAX_IMAGE_PIXELS` | `50000000` | Decoded-pixel ceiling for raster images |
| `CLEARDOC_RETENTION_MS` | `3600000` | Temp-file retention |
| `CLEARDOC_CLEANUP_INTERVAL_MS` | `300000` | GC cycle interval |
| `CLEARDOC_PROCESSING_DEADLINE_MS` | `120000` | Per-stage processing deadline |
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
