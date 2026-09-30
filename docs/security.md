# ClearDoc Security Model

Every claim below corresponds to an automated check in `tests/e2e.ts` (54 checks,
passing against dev and production builds) unless explicitly marked otherwise.

## Upload validation

- Magic-byte sniffing decides the type; the declared filename/extension is never
  trusted (HTML/ZIP/EXE renamed to `.pdf` → 415; SVG → 415; empty → rejected;
  truncated PDF → honest 4xx).
- Limits: 30 MB (`LIMIT_FILE_SIZE` → honest JSON 413 via the terminal error
  middleware), 50 pages (`PAGE_LIMIT_EXCEEDED`), parser validation by pdfjs/sharp.
- Uploads land in `multer.memoryStorage()` and are quarantined through
  `storageService.validateMagicBytes` before anything is written to disk.

## Session isolation (IDOR)

Every document, analysis, job, preview and download lookup is session-scoped via
`db.getDocument(id, sessionId)` / `getJob(id, sessionId)`. A valid foreign ID,
a random ID, and a deleted ID all return **404 with no existence disclosure** —
verified for GET document/analysis/job/preview/download and POST analyze/process.

## Path traversal

- Session IDs must match `^[a-zA-Z0-9_-]{10,64}$` before any path is built.
- Document IDs are server-issued UUIDs and are only ever used as map keys; output
  files are named `cleaned_<docId>.<ext>` by the server, never by user input.
- Traversal/encoded-traversal/null-byte IDs → 404 (verified). No user-controlled
  string reaches `path.join` as a path segment.

## Downloads

Strict gate: `COMPLETED` status only (`DOWNLOAD_GATED` 403 otherwise — verified).
Filename is server-constructed and control-character-sanitized
(`cleardoc_<basename><ext>`); content type derives from the validated output
extension, not the request. Verified that two documents in one session download
their own outputs only.

## Rate limiting

Per-session bucket, 20 expensive operations per 60 s window → `429
RATE_LIMIT_EXCEEDED`. The limiter is registered **after** session resolution so
buckets are keyed per session (a global-bucket mis-ordering was found and fixed —
it would have allowed one client to lock out all others). Covers uploads, analysis,
processing, fixtures.

## Resource limits

- Upload size (30 MB), page count (50), and decoded image resolution (50 MP)
  enforced at ingest (`IMAGE_TOO_LARGE` 413 for over-limit rasters).
- Processing deadline per stage (default 120 s, tunable via
  `CLEARDOC_PROCESSING_DEADLINE_MS`): a `withDeadline` race in routes.ts turns
  pathological documents into `PROCESSING_FAILED`/`VERIFICATION_FAILED` instead
  of a hang; deadline-mapped failure states are retryable and never leave a
  document stuck in `VERIFYING`.
- E2E hostile phases verify all of the above plus server survival
  (oversized upload, over-limit pages, over-limit megapixels, deadline cut-off).
- NOT solved in V1: hard memory ceilings on pathological in-process parsing
  (single-instance deployment expectation; see limitations).

## Cleanup / privacy

- 1 h retention, 5 min GC cycle deleting metadata + files (idempotency tested);
  startup sweep purges sessions orphaned by a previous process once retention
  elapses (verified).
- `.gitignore` excludes `storage/temp/`; no user documents ever enter version control.

## Headers

`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin` on every response (verified).
TLS/HSTS are the responsibility of the reverse proxy in front of ClearDoc.

## Dependency policy

Runtime dependencies are limited to the processing stack (express, multer, sharp,
pdf-lib, pdfjs-dist, pixelmatch, pngjs, uuid, dotenv, @napi-rs/canvas) and the UI
(react, react-dom, lucide-react). Build tooling lives in devDependencies.
Remove any dependency that no longer has call sites rather than accumulating.
