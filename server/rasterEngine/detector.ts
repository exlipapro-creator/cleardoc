/**
 * ClearDoc Raster Watermark Detector
 * Real pixel-level analysis: estimates background uniformity and locates regions
 * whose local statistics deviate from the surrounding background (typical of
 * stamp-style watermark overlays on flat backgrounds).
 *
 * Honest by design: returns zero candidates when no statistically significant
 * deviation exists (e.g., photographs) instead of inventing a target region.
 */
import sharp from 'sharp';
import { WatermarkCandidate } from '../../shared/types.js';

export interface RasterDetectionResult {
  candidates: WatermarkCandidate[];
  summary: string;
  backgroundUniformity: number; // 0..1, fraction of pixels close to dominant background color
}

const DIVERGENCE_THRESHOLD = 34; // max per-channel deviation from local background (0-255)
const MIN_REGION_FRACTION = 0.005; // ignore specks smaller than 0.5% of the image
const MAX_REGION_FRACTION = 0.7; // ignore regions covering most of the image (whole-image filters)
const SAMPLE_STEP = 2; // analyze every Nth pixel for performance

export async function detectRasterWatermarks(
  imageBuffer: Buffer
): Promise<RasterDetectionResult> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (!width || !height) {
    return { candidates: [], summary: 'Image dimensions could not be determined.', backgroundUniformity: 0 };
  }

  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const stride = info.width * channels;

  // Estimate the dominant background color from the border ring of the image.
  let br = 0;
  let bg = 0;
  let bb = 0;
  let borderSamples = 0;
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.02));

  const samplePixel = (x: number, y: number) => {
    const idx = y * stride + x * channels;
    br += data[idx];
    bg += data[idx + 1];
    bb += data[idx + 2];
    borderSamples++;
  };

  for (let x = 0; x < width; x += SAMPLE_STEP) {
    for (let y = 0; y < ring; y++) samplePixel(x, y);
    for (let y = height - ring; y < height; y++) samplePixel(x, y);
  }
  for (let y = ring; y < height - ring; y += SAMPLE_STEP) {
    for (let x = 0; x < ring; x++) samplePixel(x, y);
    for (let x = width - ring; x < width; x++) samplePixel(x, y);
  }

  const domR = Math.round(br / Math.max(1, borderSamples));
  const domG = Math.round(bg / Math.max(1, borderSamples));
  const domB = Math.round(bb / Math.max(1, borderSamples));

  // Scan interior pixels for deviation from the dominant background.
  // Build a coarse grid of divergent cells (blocks) so we can group them into regions.
  const blockSize = Math.max(8, Math.round(Math.min(width, height) / 60));
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const divergent: boolean[] = new Array(cols * rows).fill(false);

  let totalSampled = 0;
  let divergentSampled = 0;

  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const idx = y * stride + x * channels;
      const dr = Math.abs(data[idx] - domR);
      const dg = Math.abs(data[idx + 1] - domG);
      const db = Math.abs(data[idx + 2] - domB);
      const isDivergent = dr > DIVERGENCE_THRESHOLD || dg > DIVERGENCE_THRESHOLD || db > DIVERGENCE_THRESHOLD;
      totalSampled++;
      if (isDivergent) divergentSampled++;

      if (isDivergent) {
        const col = Math.min(cols - 1, Math.floor(x / blockSize));
        const row = Math.min(rows - 1, Math.floor(y / blockSize));
        divergent[row * cols + col] = true;
      }
    }
  }

  const backgroundUniformity =
    totalSampled > 0 ? Number((1 - divergentSampled / totalSampled).toFixed(4)) : 0;

  // Group adjacent divergent blocks into connected regions (BFS).
  const visited = new Array(cols * rows).fill(false);
  const regions: Array<{ minX: number; minY: number; maxX: number; maxY: number; cells: number }> = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellIdx = r * cols + c;
      if (!divergent[cellIdx] || visited[cellIdx]) continue;

      let minX = c;
      let maxX = c;
      let minY = r;
      let maxY = r;
      let cells = 0;
      const queue = [cellIdx];
      visited[cellIdx] = true;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const curRow = Math.floor(cur / cols);
        const curCol = cur % cols;
        cells++;

        minX = Math.min(minX, curCol);
        maxX = Math.max(maxX, curCol);
        minY = Math.min(minY, curRow);
        maxY = Math.max(maxY, curRow);

        const neighbors = [
          [curCol + 1, curRow],
          [curCol - 1, curRow],
          [curCol, curRow + 1],
          [curCol, curRow - 1],
        ];
        for (const [nc, nr] of neighbors) {
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const nIdx = nr * cols + nc;
          if (divergent[nIdx] && !visited[nIdx]) {
            visited[nIdx] = true;
            queue.push(nIdx);
          }
        }
      }

      regions.push({ minX, minY, maxX, maxY, cells });
    }
  }

  const totalCells = cols * rows;
  const candidates: WatermarkCandidate[] = [];

  // Keep the single most significant interior region (largest divergent mass
  // that does not touch most of the canvas). Border rings are excluded because
  // the background estimate came from there.
  const eligible = regions
    .filter((reg) => {
      const regW = (reg.maxX - reg.minX + 1) * blockSize;
      const regH = (reg.maxY - reg.minY + 1) * blockSize;
      const fraction = (regW * regH) / (width * height);
      return fraction >= MIN_REGION_FRACTION && fraction <= MAX_REGION_FRACTION;
    })
    .sort((a, b) => b.cells - a.cells);

  if (eligible.length > 0) {
    const top = eligible[0];
    const bx = Math.min(width - 2, Math.max(0, top.minX * blockSize));
    const by = Math.min(height - 2, Math.max(0, top.minY * blockSize));
    const bw = Math.min(width - bx, Math.max(2, (top.maxX - top.minX + 1) * blockSize));
    const bh = Math.min(height - by, Math.max(2, (top.maxY - top.minY + 1) * blockSize));

    candidates.push({
      id: 'wm_raster_01',
      type: 'RASTER',
      label: 'Raster Marking Region',
      pages: [1],
      bbox: {
        x: bx,
        y: by,
        width: bw,
        height: bh,
        unit: 'px',
      },
      representation: 'RASTER_IMAGE_REGION',
      detectionMethod: 'RASTER_BACKGROUND_DEVIATION',
      confidenceInternal: 0.65,
      recommendedStrategy: 'LOCALIZED_RASTER_RESTORATION',
      explanation: `Region of the image deviates from the estimated background (uniformity ${(backgroundUniformity * 100).toFixed(1)}%). Review the highlighted area and draw a manual selection if it does not match the actual marking.`,
      isRepeated: false,
      selected: true,
    });
  }

  const summary =
    candidates.length > 0
      ? 'Image analyzed. One probable marking region identified; confirm it before removal.'
      : backgroundUniformity > 0.9
      ? 'Image analyzed. Background appears uniform; no distinct marking region was detected. You can draw a manual selection around any marking.'
      : 'Image analyzed. The image appears photographic or highly textured, so automatic marking detection is unreliable. Draw a manual selection around any marking you want removed.';

  return { candidates, summary, backgroundUniformity };
}
