# ClearDoc Deployment

## Supported topology (V1)

**Exactly one server process per storage directory.** Metadata is in-memory and
files are local — there is no shared store. Do not run two instances against the
same `storage/` path, and do not put multiple instances behind one load balancer
without session affinity *and* separate storage roots (which changes behavior —
not supported in V1).

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
| `CLEARDOC_RETENTION_MS` | `3600000` | Temp-file retention |
| `CLEARDOC_CLEANUP_INTERVAL_MS` | `300000` | GC cycle interval |
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

## Not provided in V1

- Docker images / compose files (none exist in the repo — do not assume one).
- Horizontal scaling, queues, external databases, object storage.
- Metrics/tracing endpoints; logs are structured console output only.
