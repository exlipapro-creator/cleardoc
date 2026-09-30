# ClearDoc Architecture

## Overview

Single-process Node.js application serving both the HTTP API and the built SPA.
No external services. No database. One storage directory.

```
Browser (React SPA, dist/assets)
   │  fetch /api/*  (x-session-id header)
   ▼
Express (server.ts)
   ├── security headers → /api router (server/routes.ts)
   │      resolveSession → rateLimit → routes
   ├── /health, /ready
   ├── API 404 boundary (unknown /api/* → JSON 404, never the SPA shell)
   └── static dist/ (production) or Vite middleware (development)
```

## Module map

| Module | Responsibility |
|---|---|
| `server.ts` | Bootstrap, security headers, `/health`, `/ready`, static serving, `unhandledRejection` handler |
| `server/routes.ts` | All API orchestration: upload validation, analysis, processing pipeline, verification gating, downloads, fixtures endpoint, multer error handler |
| `server/config.ts` | Environment-driven limits (size, pages, retention, DPI), storage paths, engine versions |
| `server/db.ts` | In-memory metadata store with **enforced state machine** — illegal transitions are rejected (return `null`), never just logged |
| `server/storage.ts` | Session-scoped temp directories (`original/ working/ output/ previews/`), magic-byte validation, retention-based GC |
| `server/cleanup.ts` | Periodic GC worker + startup sweep for orphaned sessions |
| `server/fixtures.ts` | Real sample-document generators (PDF via pdf-lib, PNG via SVG→sharp) used by the `/api/fixtures/create-sample` endpoint |
| `server/pdfEngine/*` | `inspector` (pdfjs parse), `detector` (multi-signal candidate detection), `planner` (deterministic removal plan), `remover` (surgical content-stream operator removal via pdf-lib), `renderer` (page rasterization) |
| `server/rasterEngine/*` | `detector` (background-deviation pixel analysis), `processor` (localized restoration), `verifier` (measured pixel-diff containment) |
| `server/verificationEngine/*` | Independent multi-dimensional PDF verification (structural + visual + residual) |
| `src/` | React SPA: upload, candidate review, manual raster region selection, verification report, download |
| `shared/types.ts` | Shared API contracts (document/job/analysis/verification records, state union) |

## Document state machine

Enforced in `db.ts.validateTransition` — any illegal transition returns `null` and
is rejected by the route layer (`409 INVALID_STATE`):

```
UPLOADED → ANALYZING → AWAITING_REVIEW → PROCESSING → VERIFYING
                                                        ├── COMPLETED          (terminal)
                                                        ├── REVIEW_REQUIRED ──┬─ COMPLETED (user approval)
                                                        │                     └─ PROCESSING (re-process)
                                                        └── VERIFICATION_FAILED ── PROCESSING (retry)
ANALYZING → ANALYSIS_FAILED → ANALYZING (retry analysis)
PROCESSING → PROCESSING_FAILED → PROCESSING (retry)
UPLOADED → VALIDATION_FAILED (terminal)
Any state → EXPIRED | DELETED (retention/cleanup)
COMPLETED, EXPIRED, DELETED: no outgoing transitions.
```

## Processing deadline

Every engine call inside `/process` (`executeNativeRemoval`, `verifyProcessedPdf`,
`processRasterWatermark`, `verifyProcessedRaster`) runs under a 120 s
`withDeadline` race. A pathological document produces `PROCESSING_FAILED` instead
of hanging the worker.

## Persistence decision (explicit, V1)

Single-instance, in-memory metadata + local temp files. Rationale: V1 is a
temporary-processing service with automatic purge; no durable document store is
required by the product specification. Consequences are documented in the README
and `docs/deployment.md`. Do not scale horizontally with this architecture.
