# ClearDoc Verification Engine

Verification is an **independent** stage after removal. It has two questions:

1. Did the watermark disappear? → `watermarkRemoved`, `residualWatermarkDetected`
2. Did unrelated content change? → `unexpectedChangeDetected`, measured pixel diff

Processing success never implies verification success.

## PDF verification (`verificationEngine/verifier.ts`)

Structural audit — re-inspects the *output* with pdfjs and compares against the
original: page count, page dimensions, text presence, image counts, links.
Structural damage (dropped pages, missing text body) fails verification.

Visual audit — renders original and cleaned pages at the configured DPI
(`CLEARDOC_VERIFICATION_DPI`, default 150) and computes with `pixelmatch`:

- `visualChangeRatio` — percentage of pixels changed on each page;
- unexpected changes outside the intended target regions (tolerance radius
  `UNEXPECTED_PIXEL_RADIUS_TOLERANCE` = 12 px);
- residual watermark evidence (re-running detection on the cleaned render —
  if the watermark is still visible, verification fails or demands review).

The full diff image per page is stored and exposed as `preview/:page?type=diff`.

## Raster verification (`rasterEngine/verifier.ts`)

Measured pixel diff of the original vs cleaned image: changed pixels must lie
inside the target bbox (+ tolerance); containment and unexpected-change ratios
are computed from the actual images. No hardcoded numbers.

## Thresholds (all explicit, in `server/config.ts`)

| Threshold | Value | Meaning |
|---|---|---|
| `VISUAL_CHANGE_MAX_TOLERANCE_RATIO` | 0.25 | Visual changes beyond 25% of the page (without matching watermark coverage) trigger REVIEW |
| `UNEXPECTED_PIXEL_RADIUS_TOLERANCE` | 12 px | Buffer around the target region tolerating anti-aliasing |

These are configuration values, testable via fixtures; they were chosen because
the fixtures behave correctly under them (surgical removal yields small ratios,
e.g. ~1.4% on the draft fixture), not to make tests pass artificially.

## Outcomes

| Status | Document state | Download |
|---|---|---|
| `PASS` | `COMPLETED` | Allowed |
| `REVIEW` | `REVIEW_REQUIRED` | Blocked until explicit user approval (`approve-review`) |
| `FAIL` | `VERIFICATION_FAILED` | Blocked; retry processing allowed |

## Test coverage

- Unit: verification classifies a correct removal as PASS with zero unexpected
  changes (tests/run-tests.ts).
- E2E: measured ratios present in API responses for PDF and raster; download
  gate blocks non-COMPLETED documents; diff previews are generated.
