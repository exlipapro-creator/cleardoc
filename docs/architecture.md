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
| `server/db.ts` | Metadata store facade — selects the backend from config; **enforced state machine** (illegal transitions return `null`, never just logged) |
| `server/persist.ts` | Interchangeable backends: `MemoryBackend` (per-process Maps, V1 default) and `SqliteBackend` (shared SQLite via `node:sqlite`, WAL, CAS state transitions for multi-instance safety) |
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
`processRasterWatermark`, `verifyProcessedRaster`) runs under a configurable
`withDeadline` race (default 120 s, `CLEARDOC_PROCESSING_DEADLINE_MS`). A
pathological document produces `PROCESSING_FAILED` (or `VERIFICATION_FAILED` if
the deadline fires during verification — the legal failure state for that stage)
instead of hanging the worker. Raster ingest is additionally bounded by a
decoded-pixel ceiling (`CLEARDOC_MAX_IMAGE_PIXELS`).

## Persistence (explicit)

**Default (single instance):** in-memory metadata + local temp files. V1 is a
temporary-processing service with automatic purge; no durable store required.
Consequences are documented in the README and `docs/deployment.md`.

**Opt-in multi-instance (V2):** set `CLEARDOC_SHARED_DB_PATH` (SQLite via
`node:sqlite`, WAL, `busy_timeout`) **and** `CLEARDOC_SHARED_STORAGE_ROOT`
(shared volume). Both instances then read/write the same metadata and serve the
same session file tree. Cross-instance double-processing is prevented by an
atomic compare-and-set claim (`claimDocument`: `UPDATE … WHERE id = ? AND
status = ?` against the status the caller observed) — exactly one instance can
win a `AWAITING_REVIEW → PROCESSING` race; the loser reports 409. All of this
is verified by E2E phase 4 (checks M01–M14: shared visibility, cross-instance
download, IDOR across instances, race mutual exclusion, single artifact).

Fail-fast: configuring only one of the two shared variables refuses to boot.
