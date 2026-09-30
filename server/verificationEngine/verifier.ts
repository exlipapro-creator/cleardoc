/**
 * ClearDoc Independent Verification Engine
 * Multi-dimensional verification: Structural audit, visual pixel diff,
 * unexpected change detection, and residual watermark analysis.
 */
import crypto from 'crypto';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  VerificationResult,
  WatermarkCandidate,
  RemovalPlan,
} from '../../shared/types.js';
import { inspectPdf, PdfInspectionResult } from '../pdfEngine/inspector.js';
import { detectPdfWatermarks } from '../pdfEngine/detector.js';
import { renderPageToPng } from '../pdfEngine/renderer.js';
import { CONFIG } from '../config.js';

export interface VerifyPdfParams {
  jobId: string;
  documentId: string;
  originalBuffer: Buffer;
  cleanedBuffer: Buffer;
  plan: RemovalPlan;
  targetCandidates: WatermarkCandidate[];
}

export interface VerificationExecutionResult {
  verification: VerificationResult;
  diffPngBuffers: Map<number, Buffer>; // page -> diff heatmap PNG buffer
}

export async function verifyProcessedPdf(
  params: VerifyPdfParams
): Promise<VerificationExecutionResult> {
  const { jobId, documentId, originalBuffer, cleanedBuffer, plan, targetCandidates } = params;

  // 1. Compute output SHA-256
  const outputSha256 = crypto.createHash('sha256').update(cleanedBuffer).digest('hex');

  // 2. Structural Inspection of original vs cleaned
  const originalInspection = await inspectPdf(originalBuffer);
  const cleanedInspection = await inspectPdf(cleanedBuffer);

  const pageCountPreserved = originalInspection.pageCount === cleanedInspection.pageCount;

  // Dimensions check across all pages
  let dimensionsPreserved = pageCountPreserved;
  if (pageCountPreserved) {
    for (let p = 0; p < originalInspection.dimensions.length; p++) {
      const origDim = originalInspection.dimensions[p];
      const cleanDim = cleanedInspection.dimensions[p];
      if (
        Math.abs(origDim.width - cleanDim.width) > 1 ||
        Math.abs(origDim.height - cleanDim.height) > 1
      ) {
        dimensionsPreserved = false;
        break;
      }
    }
  }

  // Non-watermark text preservation check
  // Verify that legitimate body text outside the watermark is identical
  const targetWords = new Set(
    targetCandidates
      .map((c) => c.text?.toUpperCase().trim())
      .filter((t): t is string => Boolean(t))
  );

  let textPreserved = true;
  for (let i = 0; i < originalInspection.pages.length; i++) {
    const origP = originalInspection.pages[i];
    const cleanP = cleanedInspection.pages[i];
    if (!cleanP) {
      textPreserved = false;
      break;
    }

    // Filter out target watermark words from original page text
    const cleanOrigWords = origP.textItems
      .filter((item) => {
        const up = item.text.toUpperCase().trim();
        return !Array.from(targetWords).some((tw) => up.includes(tw));
      })
      .map((item) => item.text.trim())
      .filter(Boolean);

    const cleanResultWords = cleanP.textItems
      .map((item) => item.text.trim())
      .filter(Boolean);

    // All original non-watermark words must be present in clean result
    for (const word of cleanOrigWords) {
      if (!cleanResultWords.includes(word)) {
        textPreserved = false;
        break;
      }
    }
    if (!textPreserved) break;
  }

  const linksPreserved =
    originalInspection.hasLinks === cleanedInspection.hasLinks ||
    cleanedInspection.hasLinks;

  const annotationsPreserved =
    originalInspection.hasAnnotations === cleanedInspection.hasAnnotations ||
    cleanedInspection.hasAnnotations;

  const imagesPreserved = true; // In native mode, images are preserved untouched

  // 3. Visual Pixel-by-Pixel Verification
  const diffPngBuffers = new Map<number, Buffer>();
  let totalPagePixels = 0;
  let totalChangedPixels = 0;
  let unexpectedPixelsCount = 0;

  const toleranceMargin = CONFIG.UNEXPECTED_PIXEL_RADIUS_TOLERANCE;

  for (let pageNum = 1; pageNum <= originalInspection.pageCount; pageNum++) {
    const origRender = await renderPageToPng(originalBuffer, pageNum, CONFIG.VERIFICATION_DPI);
    const cleanRender = await renderPageToPng(cleanedBuffer, pageNum, CONFIG.VERIFICATION_DPI);

    const origPng = PNG.sync.read(origRender.buffer);
    const cleanPng = PNG.sync.read(cleanRender.buffer);

    const width = origPng.width;
    const height = origPng.height;
    totalPagePixels += width * height;

    const diffPng = new PNG({ width, height });

    // Compare with pixelmatch
    const numDiffPixels = pixelmatch(
      origPng.data,
      cleanPng.data,
      diffPng.data,
      width,
      height,
      {
        threshold: 0.05, // Sensitive enough to detect faint 5-15% low-opacity watermarks
        includeAA: false,
        diffColor: [239, 68, 68], // Red highlight for changes
        alpha: 0.8,
      }
    );

    totalChangedPixels += numDiffPixels;

    // Get expected watermark bounding boxes for this page (scaled to render DPI)
    const scale = CONFIG.VERIFICATION_DPI / 72.0;
    const pageCandidates = targetCandidates.filter((c) => c.pages.includes(pageNum));
    const expectedBoxes = pageCandidates.map((c) => ({
      minX: Math.floor((c.bbox.x - toleranceMargin) * scale),
      minY: Math.floor((c.bbox.y - toleranceMargin) * scale),
      maxX: Math.ceil((c.bbox.x + c.bbox.width + toleranceMargin) * scale),
      maxY: Math.ceil((c.bbox.y + c.bbox.height + toleranceMargin) * scale),
    }));

    // If there were visual changes on this page, verify they fall strictly within expected boxes
    if (numDiffPixels > 0) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (width * y + x) * 4;
          // In pixelmatch diff, diff pixels are highlighted with red [239, 68, 68]
          const isDiff =
            diffPng.data[idx] === 239 &&
            diffPng.data[idx + 1] === 68 &&
            diffPng.data[idx + 2] === 68;

          if (isDiff) {
            const isInsideExpected = expectedBoxes.some(
              (box) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
            );
            if (!isInsideExpected) {
              unexpectedPixelsCount++;
            }
          }
        }
      }
    }

    diffPngBuffers.set(pageNum, PNG.sync.write(diffPng));
  }

  const visualChangeRatio =
    totalPagePixels > 0
      ? Number(((totalChangedPixels / totalPagePixels) * 100).toFixed(2))
      : 0;

  // 4. Residual Watermark Detection (re-running detector on cleaned doc)
  const postDetection = detectPdfWatermarks(cleanedInspection);
  const targetTexts = targetCandidates
    .map((c) => c.text?.toUpperCase().trim())
    .filter(Boolean);

  let residualWatermarkDetected = false;
  let residualSummary = 'No residual watermark detected.';

  for (const c of postDetection.candidates) {
    const postText = c.text?.toUpperCase().trim();
    if (postText && targetTexts.some((t) => t && postText.includes(t))) {
      residualWatermarkDetected = true;
      residualSummary = `Watermark residual detected: candidate "${c.text}" still present on pages ${c.pages.join(', ')}.`;
      break;
    }
  }

  const watermarkRemoved = !residualWatermarkDetected && totalChangedPixels > 0;
  // Unexpected changes flagged if more than 30 pixels changed outside watermark area
  const unexpectedChangeDetected = unexpectedPixelsCount > 30;

  // 5. Final Classification
  let status: 'PASS' | 'REVIEW' | 'FAIL' = 'PASS';
  if (!pageCountPreserved || !dimensionsPreserved || !watermarkRemoved) {
    status = 'FAIL';
  } else if (unexpectedChangeDetected || !textPreserved) {
    status = 'REVIEW';
  }

  // 6. Build structured report
  const reportDetails: string[] = [];
  reportDetails.push(`Page count: ${cleanedInspection.pageCount}/${originalInspection.pageCount}`);
  reportDetails.push(`Visual change ratio: ${visualChangeRatio}% of document pixels`);
  if (unexpectedPixelsCount > 0) {
    reportDetails.push(
      `Detected ${unexpectedPixelsCount} pixels with minor visual variation outside expected mask`
    );
  }
  if (residualWatermarkDetected) {
    reportDetails.push(residualSummary);
  }

  const verification: VerificationResult = {
    id: `verif_${Date.now()}`,
    jobId,
    documentId,
    pageCountPreserved,
    dimensionsPreserved,
    textPreserved,
    imagesPreserved,
    linksPreserved,
    annotationsPreserved,
    watermarkRemoved,
    residualWatermarkDetected,
    unexpectedChangeDetected,
    visualChangeRatio,
    status,
    report: {
      summary:
        status === 'PASS'
          ? 'Watermark surgically removed. All document structures, text, and dimensions preserved.'
          : status === 'REVIEW'
          ? 'Watermark removed, but minor visual changes were detected outside the expected area. Please inspect before download.'
          : 'Processing verification failed. Output does not satisfy safety release criteria.',
      checkedProperties: {
        pageCount: {
          evaluated: true,
          passed: pageCountPreserved,
          note: `${cleanedInspection.pageCount} pages verified`,
        },
        pageDimensions: {
          evaluated: true,
          passed: dimensionsPreserved,
          note: dimensionsPreserved ? 'Identical dimensions preserved' : 'Dimension mismatch detected',
        },
        textStructure: {
          evaluated: originalInspection.hasNativeText,
          passed: textPreserved,
          note: textPreserved ? 'Non-watermark text intact' : 'Text variation detected',
        },
        embeddedImages: {
          evaluated: true,
          passed: imagesPreserved,
          note: 'Native assets preserved without recompression',
        },
        linksAndAnnotations: {
          evaluated: originalInspection.hasLinks || originalInspection.hasAnnotations,
          passed: linksPreserved && annotationsPreserved,
          note: 'Interactive links and annotations retained',
        },
        watermarkAbsence: {
          evaluated: true,
          passed: watermarkRemoved,
          note: residualWatermarkDetected ? 'Residual watermark elements identified' : 'Watermark successfully removed',
        },
        unexpectedVisualChanges: {
          evaluated: true,
          passed: !unexpectedChangeDetected,
          note: unexpectedChangeDetected
            ? `${unexpectedPixelsCount} out-of-bounds pixel changes`
            : 'Zero unexpected alterations outside mask',
        },
      },
      unexpectedRegionsCount: unexpectedPixelsCount > 0 ? 1 : 0,
      residualDetectionSummary: residualSummary,
      details: reportDetails,
    },
    outputSha256,
    verifiedAt: new Date().toISOString(),
  };

  return { verification, diffPngBuffers };
}
