# ClearDoc Document Processing

## Pipeline

```
UPLOAD → VALIDATE → ANALYZE → DETECT → REVIEW → PLAN → REMOVE → VERIFY → COMPARE
       → PASS / REVIEW_REQUIRED / VERIFICATION_FAILED → DOWNLOAD → AUTOMATIC CLEANUP
```

## PDF path (native)

1. **Inspect** (`pdfEngine/inspector.ts`): pdfjs parses the real document — page
   count, dimensions, text items (string, position, font, size), image counts.
   Unparseable/corrupt/truncated PDFs fail here with honest errors.
2. **Detect** (`pdfEngine/detector.ts`): multi-signal scoring over the *actual*
   text items — repetition, rotation, oversized font, page-spanning geometry,
   placement, and watermark vocabulary. Vocabulary alone is never sufficient
   (e.g. `COPYRIGHT` is not matched as a `COPY` watermark — word boundaries are
   respected; regression-tested).
3. **Review**: the client selects candidates; nothing is removed without
   selection. Clean documents report zero candidates and processing is refused
   with `NO_TARGET_SELECTED`.
4. **Plan** (`pdfEngine/planner.ts`): deterministic, machine-readable plan
   (strategy + operators to remove), hashed into the job record.
5. **Remove** (`pdfEngine/remover.ts`): surgical content-stream operator removal
   via pdf-lib on the *unrasterized* document — text, fonts, links, annotations
   and page geometry outside the watermark are preserved.
6. **Verify** (`verificationEngine/verifier.ts`): independent re-inspection —
   structural audit (pages, dimensions, text, images, links) **and** rendered
   pixel diff (original vs cleaned at fixed DPI) computing changed-pixel ratio,
   out-of-region unexpected changes, and residual watermark evidence.
   Processing success ≠ verification success; they are separate stages
   (`PROCESSING` → `VERIFYING` are distinct states).

## Raster path (PNG/JPEG/WEBP/TIFF)

1. **Detect** (`rasterEngine/detector.ts`): real pixel analysis — estimates the
   dominant background, then locates regions whose local statistics deviate
   beyond `DIVERGENCE_THRESHOLD` (34/255 per channel) and above
   `MIN_REGION_FRACTION` (0.5% of the image). Photographs/uniform documents
   produce **zero candidates** — never a fabricated region.
2. **Manual region** (optional, raster only): the client draws a box; the server
   accepts `manualRegions` with page + bbox. PDFs reject manual regions with
   `MANUAL_REGIONS_UNSUPPORTED`.
3. **Process** (`rasterEngine/processor.ts`): localized reconstruction — samples
   the perimeter around the target bbox and refills it; pixels outside the
   region are untouched.
4. **Verify** (`rasterEngine/verifier.ts`): measured pixel diff — changed pixels
   must be contained in the target region (plus tolerance radius 12 px);
   unexpected changes are measured, not assumed away.

## Failure behavior

- Every engine call is bounded by the 120 s deadline (`withDeadline`).
- Any failure maps to `PROCESSING_FAILED` (retryable) or `VERIFICATION_FAILED`
  (retryable) — never a false `COMPLETED`.
- Verification outcomes: `PASS` → downloadable; `REVIEW` → `REVIEW_REQUIRED`
  (explicit user approval can complete it); `FAIL` → terminal for that job,
  retry allowed.

## Honest-case behavior (regression-tested)

- No watermark → zero candidates, no processing target.
- `COPYRIGHT`, `INTERNAL` as legitimate prose → not treated as watermark terms.
- Corrupt/truncated PDFs, fake magic bytes, oversized files → rejected at ingest.
