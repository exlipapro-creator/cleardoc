# ClearDoc

ClearDoc is a web application that removes watermarks from PDF documents and images —
with independent verification. Every removal is followed by a measured structural and
pixel-level audit of the output. Documents whose results cannot be proven safe are
**not** released for download: they are flagged `REVIEW_REQUIRED` or
`VERIFICATION_FAILED` instead.

ClearDoc never confuses *"the processing function returned successfully"* with
*"the document was safely transformed"*. Only the latter unlocks the download.

## What it does

1. **Upload** — PDF, PNG, JPEG, WEBP or TIFF (magic-byte validated, ≤ 30 MB, ≤ 50 pages, ≤ 16 megapixels decoded by default for raster images — the largest MEASURED-safe ceiling for a 512 MB Render Free instance; override with `CLEARDOC_MAX_IMAGE_PIXELS`). PDFs are additionally bounded by a text-density ceiling (`CLEARDOC_MAX_TEXT_ITEMS`, default 8,000 items — render memory scales with text operations, not file size) and a rendered-page pixel ceiling (`CLEARDOC_MAX_RENDER_PIXELS`, default 16 MP). Pages embedding large images are additionally bounded by a per-page embedded-image pixel ceiling (`CLEARDOC_MAX_PDF_IMAGE_PIXELS_PER_PAGE`, default 2 MP — image-decode CPU scales with embedded image pixels, not file size).
2. **Analyze** — real structural inspection (PDF text items, fonts, images) or real
   pixel-level background-deviation analysis (raster images). A document with no
   watermark gets **zero candidates**, honestly.
3. **Review** — detected candidates are shown with geometry, evidence and confidence.
   You choose what to remove. Nothing is removed automatically without your selection.
4. **Process** — a deterministic removal plan is executed:
   - **PDF (native)**: surgical content-stream operator removal via `pdf-lib` —
     no rasterization; text, fonts, links, annotations and page geometry are preserved.
   - **Raster**: localized background reconstruction inside the target region only
     (sharp + raw pixel manipulation).
5. **Verify** — an independent engine re-inspects the output: structural audit
   (page count, dimensions, text, images, links) plus a rendered pixel diff
   (`pixelmatch`) that measures changed pixels, unexpected out-of-region changes
   and residual watermark evidence.
6. **Download** — gated: only `COMPLETED` (verification PASS) or user-approved
   `REVIEW_REQUIRED` documents can be downloaded.
7. **Automatic cleanup** — all originals, outputs, previews and intermediates are
   deleted one hour after upload (configurable), by a periodic GC worker plus a
   startup sweep for files orphaned by a restart. Download promptly: outputs
   share the 1-hour ephemeral lifecycle.

## Supported formats

| Input | Engine | Manual region support |
|---|---|---|
| PDF (native text) | Native surgical removal | Not supported (rejected with `MANUAL_REGIONS_UNSUPPORTED`) |
| PDF (scanned / image-only) | Detected honestly; raster-style candidates only | Not supported |
| PNG / JPEG / WEBP / TIFF | Localized raster restoration | Supported |

## Privacy & retention

- Files stay on the server **only** in `storage/temp/<session>/`, one hour max
  (`CLEARDOC_RETENTION_MS`).
- GC runs every 5 minutes and deletes expired sessions (metadata **and** files);
  idempotent by design. On boot, a startup sweep purges sessions orphaned by a
  previous process once they exceed retention age.
- No third-party services, no telemetry, no external calls. Everything runs locally.

## Local development

Requirements: Node.js 20+, npm.

```bash
npm install        # plain npm install works; no --legacy-peer-deps needed
npm run dev        # tsx server.ts → http://localhost:3000 (Vite middleware, HMR)
```

## Testing

```bash
npm run lint       # TypeScript, strict, whole project
npm test           # 17 unit/integration tests (engines, detector honesty, GC, state machine, pipeline gate, config safety)
npm run test:e2e   # 103-check live E2E: boots a real server, full release + hardening checklist
BUILD=prod npm run test:e2e   # same 103 checks against the production build artifacts
```

The E2E suite covers: happy paths (PDF + raster), IDOR/cross-session access,
path traversal, upload validation (fake/renamed/corrupt/truncated/empty files),
state-machine gates, duplicate-processing race, manual raster regions, download
gating, failure paths, rate limiting — a resource-exhaustion phase
(oversized upload, over-limit page count, over-limit image resolution, and a
deterministic processing-deadline cut-off asserting PROCESSING_FAILED with the
server surviving) — plus a deployment-hardening phase: exact image-pixel
boundary behavior at the 16 MP ceiling, PDF text-density and page-size ceilings, processing admission-gate semantics
(one 200 + one 503 SERVICE_BUSY on concurrent heavy jobs, slot released on
success), deterministic post-restart session expiry, and health/uptime probes.

## Production deployment

```bash
npm ci
npm run build      # vite build → dist/ + esbuild server bundle → dist/server.js
NODE_ENV=production PORT=3000 node dist/server.js
```

- `GET /health` — liveness (process + engine versions).
- `GET /ready` — readiness (storage root writable).
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`)
  are set on every response. Run behind a reverse proxy for TLS termination.

## Known limitations

- **Default mode is single-instance** (in-memory metadata + local temp files).
  For two or more instances behind a load balancer, enable shared mode by
  setting `CLEARDOC_SHARED_DB_PATH` (SQLite, zero external dependencies) and
  `CLEARDOC_SHARED_STORAGE_ROOT` (shared volume) on every instance. See
  `docs/deployment.md` for the verified topology and its constraints.
- **Processing admission gate**: heavy processing (removal + verification) is
  capped at `CLEARDOC_MAX_CONCURRENT_PROCESSES` simultaneous pipelines
  (default **1** — a memory-safety decision measured against a 512 MB
  Render Free instance). Excess requests wait up to
  `CLEARDOC_PROCESS_SLOT_WAIT_MS` (default 5 s), then receive an honest
  `503 SERVICE_BUSY` with `Retry-After` — never a hang, never an OOM.
- **Restart behavior (single-instance mode):** in-flight jobs are lost on
  restart; their files become orphans and are purged by the GC once retention
  elapses. Stale session ids get deterministic 404s (the UI surfaces
  SESSION_EXPIRED honestly). The server never reports a false `COMPLETED`
  after restart. In shared (multi-instance) mode, metadata and files survive
  individual instance restarts.
- **PDF manual regions are not supported** — the server rejects them explicitly
  rather than silently ignoring them.
- Removal targets stamped/overlay watermarks on reasonably uniform backgrounds.
  Watermarks baked over complex photographic backgrounds may be classified
  `REVIEW_REQUIRED` instead of silently "succeeding".
