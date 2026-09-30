# ClearDoc Testing

## Test layers

| Command | What runs | Status at release |
|---|---|---|
| `npm run lint` | `tsc --noEmit` over the whole project (strict) | PASS |
| `npm test` | 13 unit/integration tests via `tests/run-tests.ts` (incl. SQLite backend cross-instance CAS) | 13/13 PASS |
| `npm run test:e2e` | 84-check live E2E (`tests/e2e.ts`), boots real server processes on ephemeral ports | 84/84 PASS |
| `BUILD=prod npm run test:e2e` | The same 84 checks against `dist/server.js` + built SPA (production mode) | 84/84 PASS |

`npm ci && npm run build && npm test` is the reproducible clean-build gate;
`npm install` works without `--legacy-peer-deps` (dependency tree aligned: esbuild
0.28 for vite 8, all `@types/*` in devDependencies).

## Unit / integration suite (`tests/run-tests.ts`)

1. Storage magic-byte validation (valid + invalid buffers)
2. PDF inspector extracts page count, dimensions, text items
3. Detector finds a diagonal DRAFT watermark across pages
4. Removal planner produces a deterministic machine-readable plan
5. Native surgical removal preserves non-watermark text and page count
6. Verification engine classifies a correct removal as PASS (zero unexpected changes)
7. Clean document → honest NO watermark detection
8. Raster detector finds the marking region on the stamped fixture
9. Raster restoration verified by measured pixel diff
10. Metadata store rejects illegal state transitions (UPLOADED→PROCESSING,
    COMPLETED→PROCESSING)
11. Detector does not treat "COPYRIGHT" as a COPY watermark term
12. Expired sessions purged from disk and metadata, idempotently
13. SQLite backend cross-instance semantics: shared visibility, CAS claim race
    (exactly one winner), illegal-transition rejection, session scoping, expiry cleanup

## E2E checklist (`tests/e2e.ts`)

The authoritative release gate. Boots its own server (ephemeral port, tsx dev or
`node dist/server.js` for `BUILD=prod`) in **three phases**:

**Phase 1 — core checklist (default config):**

- `/health`, `/ready`, security headers, session bootstrap
- PDF happy path: sample → upload → analyze → candidate geometry → process →
  verification ratios → download (%PDF magic, sanitized filename) → previews
  (cleaned + diff, multi-page)
- Cross-session IDOR on document/analysis/preview/download/process/analyze (all 404)
- Traversal / encoded traversal / null-byte IDs; invalid preview page/type
- No-watermark honesty (zero candidates, `NO_TARGET_SELECTED`)
- Upload security: HTML/ZIP/EXE renamed → 415, SVG → 415, empty, truncated PDF
- State machine: re-analyze 409, re-process 409, un-analyzed process 409
- Duplicate-processing race: one winner, coherent terminal state, exactly one output file
- Raster: detection, processing, measured verification, manual region;
  PDF manual regions → 400 `MANUAL_REGIONS_UNSUPPORTED`
- Failure paths: unknown document/job 404s, process without selection
- Rate limiting: burst → 429; no bypass across endpoints

**Phase 2 — resource exhaustion (1.5s processing deadline):**

- 31 MB upload → honest 413; 51-page PDF → 400 `PAGE_LIMIT_EXCEEDED`
- 50-page watermarked PDF under deadline → 5xx `PROCESSING_FAILED`, retryable
  state, elapsed bounded, server survives
- 17.5MP raster: ingest + analysis bounded; processing resolves coherently
- 54MP raster → 413 `IMAGE_TOO_LARGE` (decoded-pixel ceiling)
- 41MP legal raster: ingest + analysis complete within bounds

**Phase 3 — deterministic deadline gate (1ms deadline):**

- Raster path under an expired deadline → 5xx `PROCESSING_FAILED`, retryable
  failure state (never a stuck `VERIFYING` or false `COMPLETED`), server healthy

**Phase 4 — multi-instance (V2 shared mode):**

- Boots two real server processes sharing one SQLite DB + storage root, then
  drives every request through a round-robin "load balancer":
- Shared visibility: upload on A → analyze on B → preview from A → process on
  A → job read from B → download from B
- IDOR holds across instances; both `/health` endpoints report `sqlite` backend
- Cross-instance double-process race: exactly one 200 + one 409
  `INVALID_STATE`, coherent terminal state, single output artifact

Exit code 0 only when every check passes — wire it into CI as the release gate.

## Manual (not automatable here)

- Browser matrix / responsive layout at 320–1440 px
- Keyboard-only walkthrough and screen-reader announcements
- Visual QA of the review UI
