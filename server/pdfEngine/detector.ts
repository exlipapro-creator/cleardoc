/**
 * ClearDoc Multi-Signal Watermark Detector
 * Evaluates repetition, rotation, font scale, geometry, placement, and vocabulary signals.
 * Never treats vocabulary alone as proof; synthesizes multi-dimensional evidence.
 */
import { WatermarkCandidate, WatermarkType, RemovalStrategy } from '../../shared/types.js';
import { PdfInspectionResult, InspectedPage, ExtractedTextItem } from './inspector.js';

const WATERMARK_VOCABULARY = [
  'DRAFT',
  'SAMPLE',
  'CONFIDENTIAL',
  'COPY',
  'VOID',
  'PREVIEW',
  'INTERNAL',
  'SPECIMEN',
  'PROOF',
  'NOT FOR DISTRIBUTION',
  'DO NOT COPY',
  'FOR REVIEW ONLY',
  'UNAPPROVED',
  'TRIAL',
  'DEMO',
  'TEST',
  'WATERMARK',
];

export interface DetectionResult {
  candidates: WatermarkCandidate[];
  summary: string;
  hasAmbiguousCandidates: boolean;
}

export function detectPdfWatermarks(inspection: PdfInspectionResult): DetectionResult {
  const candidates: WatermarkCandidate[] = [];
  const candidateMap = new Map<string, WatermarkCandidate>();

  const totalPages = inspection.pageCount;

  // 1. Group text items by normalized text and style across pages
  interface TextCluster {
    rawText: string;
    normalizedText: string;
    items: ExtractedTextItem[];
    pages: Set<number>;
    avgFontSize: number;
    avgRotation: number;
    hasVocabSignal: boolean;
  }

  const clusters = new Map<string, TextCluster>();

  for (const page of inspection.pages) {
    for (const item of page.textItems) {
      const clean = item.text.trim();
      if (clean.length < 2) continue;

      const upper = clean.toUpperCase();
      const clusterKey = `${upper}_rot${Math.round(item.rotation / 15) * 15}`;

      let cluster = clusters.get(clusterKey);
      if (!cluster) {
        // Check vocabulary signal with word boundaries so that e.g. "COPYRIGHT"
        // does not trigger the "COPY" marking term.
        const hasVocabSignal = WATERMARK_VOCABULARY.some((v) =>
          new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(upper)
        );

        cluster = {
          rawText: clean,
          normalizedText: upper,
          items: [],
          pages: new Set(),
          avgFontSize: item.fontSize,
          avgRotation: item.rotation,
          hasVocabSignal,
        };
        clusters.set(clusterKey, cluster);
      }

      cluster.items.push(item);
      cluster.pages.add(page.pageNumber);
    }
  }

  // 2. Score each cluster on multiple orthogonal signals
  let candidateCounter = 1;

  for (const cluster of clusters.values()) {
    const pagesCount = cluster.pages.size;
    const repetitionRatio = pagesCount / Math.max(1, totalPages);

    // Calculate centroid & average bounding box
    let totalX = 0;
    let totalY = 0;
    let totalW = 0;
    let totalH = 0;
    let totalBaselineX = 0;
    let totalBaselineY = 0;
    let totalFontSize = 0;
    let totalRot = 0;

    for (const it of cluster.items) {
      totalX += it.bbox.x;
      totalY += it.bbox.y;
      totalW += it.bbox.width;
      totalH += it.bbox.height;
      totalBaselineX += it.baselineOrigin ? it.baselineOrigin.x : it.bbox.x;
      totalBaselineY += it.baselineOrigin ? it.baselineOrigin.y : it.bbox.y + it.bbox.height;
      totalFontSize += it.fontSize;
      totalRot += it.rotation;
    }

    const count = cluster.items.length;
    const avgX = totalX / count;
    const avgY = totalY / count;
    const avgW = totalW / count;
    const avgH = totalH / count;
    const avgBaselineX = totalBaselineX / count;
    const avgBaselineY = totalBaselineY / count;
    const avgFontSize = totalFontSize / count;
    const avgRot = Math.round(totalRot / count) % 360;

    // Check page center placement
    // Assume average page width 600, height 800
    const firstPage = inspection.pages[0];
    const pw = firstPage?.width || 600;
    const ph = firstPage?.height || 800;

    const centerX = avgX + avgW / 2;
    const centerY = avgY + avgH / 2;

    const distFromCenter = Math.hypot(
      (centerX - pw / 2) / (pw / 2),
      (centerY - ph / 2) / (ph / 2)
    );
    const isCentral = distFromCenter < 0.65; // within central 65% of page

    // Rotation signal: diagonal angles (25-65 deg, 115-155 deg, 205-245 deg, 295-335 deg)
    const isDiagonal =
      (avgRot >= 25 && avgRot <= 65) ||
      (avgRot >= 115 && avgRot <= 155) ||
      (avgRot >= 205 && avgRot <= 245) ||
      (avgRot >= 295 && avgRot <= 335);

    // Font size signal: noticeably larger than typical body text (10-14pt)
    const isLargeFont = avgFontSize >= 28;
    const isHugeFont = avgFontSize >= 48;

    // Repetition signal: appears on multiple pages
    const isRepeatedAcrossPages = totalPages > 1 && pagesCount >= 2;

    // Calculate evidence score (0.0 to 1.0)
    let score = 0.0;
    const evidenceList: string[] = [];

    if (isDiagonal) {
      score += 0.35;
      evidenceList.push(`Diagonal orientation (${avgRot}°)`);
    }

    if (isHugeFont) {
      score += 0.30;
      evidenceList.push(`Prominent font scale (${Math.round(avgFontSize)}pt)`);
    } else if (isLargeFont) {
      score += 0.18;
      evidenceList.push(`Elevated font size (${Math.round(avgFontSize)}pt)`);
    }

    if (isRepeatedAcrossPages) {
      score += 0.30 * repetitionRatio;
      evidenceList.push(`Repeated across ${pagesCount}/${totalPages} pages`);
    }

    if (isCentral) {
      score += 0.15;
      evidenceList.push('Central document placement');
    }

    if (cluster.hasVocabSignal) {
      score += 0.20;
      evidenceList.push(`Matches standard marking term ("${cluster.rawText}")`);
    }

    // Watermark threshold: requires at least two distinct structural/contextual signals
    // A single signal (like the word "DRAFT" in small regular horizontal body text) will only score 0.20,
    // which prevents false positives on legitimate document body text!
    if (score >= 0.40) {
      const type: WatermarkType = isDiagonal ? 'DIAGONAL_TEXT' : 'TEXT';
      const candidateId = `wm_${candidateCounter++}`;

      // Calculate true bounding box enclosing rotated text
      let bboxX = Math.round(avgX);
      let bboxY = Math.round(avgY);
      let bboxW = Math.round(avgW);
      let bboxH = Math.round(avgH);

      if (avgRot !== 0) {
        const rad = (avgRot * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Effective unrotated text dimensions along baseline and perpendicular ascender
        const textLen = Math.max(avgW, cluster.rawText.length * avgFontSize * 0.70);
        const textHeight = Math.max(avgH, avgFontSize);

        // 4 corners of text box in viewport coordinates (Y points down, CCW rotation)
        const p = [
          { x: avgBaselineX, y: avgBaselineY },
          { x: avgBaselineX + textLen * cos, y: avgBaselineY - textLen * sin },
          {
            x: avgBaselineX + textLen * cos - textHeight * sin,
            y: avgBaselineY - textLen * sin - textHeight * cos,
          },
          { x: avgBaselineX - textHeight * sin, y: avgBaselineY - textHeight * cos },
        ];

        const minX = Math.min(...p.map((pt) => pt.x));
        const maxX = Math.max(...p.map((pt) => pt.x));
        const minY = Math.min(...p.map((pt) => pt.y));
        const maxY = Math.max(...p.map((pt) => pt.y));

        bboxX = Math.round(Math.max(0, minX - 10));
        bboxY = Math.round(Math.max(0, minY - 10));
        bboxW = Math.round(maxX - minX + 20);
        bboxH = Math.round(maxY - minY + 20);
      } else {
        bboxX = Math.round(Math.max(0, avgX - 10));
        bboxY = Math.round(Math.max(0, avgY - 10));
        bboxW = Math.round(avgW + 20);
        bboxH = Math.round(avgH + 20);
      }

      candidates.push({
        id: candidateId,
        type,
        label: `"${cluster.rawText}" (${type === 'DIAGONAL_TEXT' ? 'Diagonal' : 'Text'} Watermark)`,
        text: cluster.rawText,
        pages: Array.from(cluster.pages).sort((a, b) => a - b),
        bbox: {
          x: bboxX,
          y: bboxY,
          width: bboxW,
          height: bboxH,
          unit: 'pt',
        },
        rotation: avgRot,
        fontSize: Math.round(avgFontSize),
        representation: 'PDF_TEXT_OBJECT',
        detectionMethod: 'MULTI_SIGNAL_TEXT_ANALYSIS',
        confidenceInternal: Math.min(0.99, Number(score.toFixed(2))),
        recommendedStrategy: 'NATIVE_OBJECT_REMOVAL',
        explanation: `Identified based on: ${evidenceList.join(', ')}.`,
        isRepeated: isRepeatedAcrossPages,
        selected: true,
      });
    }
  }

  // Check for ambiguous candidates (score between 0.35 and 0.48)
  const hasAmbiguousCandidates = candidates.some(
    (c) => c.confidenceInternal < 0.55
  );

  let summary = '';
  if (candidates.length === 0) {
    summary = 'No prominent watermark elements detected in document stream.';
  } else {
    summary = `Detected ${candidates.length} probable watermark candidate${
      candidates.length > 1 ? 's' : ''
    }.`;
  }

  return {
    candidates,
    summary,
    hasAmbiguousCandidates,
  };
}
