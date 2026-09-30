# ClearDoc

ClearDoc is a web application that removes watermarks from PDF documents and images —
with independent verification. Every removal is followed by a measured structural and
pixel-level audit of the output. Documents whose results cannot be proven safe are
**not** released for download: they are flagged `REVIEW_REQUIRED` or
`VERIFICATION_FAILED` instead.

ClearDoc never confuses *"the processing function returned successfully"* with
*"the document was safely transformed"*. Only the latter unlocks the download.

## What it does

1. **Upload** — PDF, PNG, JPEG, WEBP or TIFF (magic-byte validated, ≤ 30 MB, ≤ 50 pages, ≤ 50 megapixels for raster images).
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
   startup sweep for files orphaned by a restart.

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
npm test           # 12 unit/integration tests (engines, detector honesty, GC, state machine)
npm run test:e2e   # 70-check live E2E: boots a real server, full release checklist
BUILD=prod npm run test:e2e   # same 70 checks against the production build artifacts
```

The E2E suite covers: happy paths (PDF + raster), IDOR/cross-session access,
path traversal, upload validation (fake/renamed/corrupt/truncated/empty files),
state-machine gates, duplicate-processing race, manual raster regions, download
gating, failure paths, rate limiting — plus a resource-exhaustion phase
(oversized upload, over-limit page count, over-limit image resolution, and a
deterministic processing-deadline cut-off asserting PROCESSING_FAILED with the
server surviving).

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

## Known limitations (V1)

- **Single instance only.** All metadata is in-memory; files are local temp files.
  Run exactly one process per storage directory. Multi-instance / horizontally
  scaled deployment requires a shared store that V1 does not provide.
- **Restart behavior:** in-flight jobs are lost on restart; their files become
  orphans and are purged by the GC once retention elapses. The server never
  reports a false `COMPLETED` after restart — documents simply no longer exist.
- **PDF manual regions are not supported** — the server rejects them explicitly
  rather than silently ignoring them.
- Removal targets stamped/overlay watermarks on reasonably uniform backgrounds.
  Watermarks baked over complex photographic backgrounds may be classified
  `REVIEW_REQUIRED` instead of silently "succeeding".
