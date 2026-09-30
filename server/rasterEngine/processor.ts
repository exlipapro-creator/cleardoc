/**
 * ClearDoc Localized Raster Restoration Engine
 * Analyzes local background surrounding the target mask and performs localized reconstruction
 * without global filtering, compression loss, or resizing outside the target region.
 */
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { BoundingBox } from '../../shared/types.js';

export interface RasterProcessOptions {
  bbox: { x: number; y: number; width: number; height: number };
  preserveEdges?: boolean;
}

export async function processRasterWatermark(
  imageBuffer: Buffer,
  options: RasterProcessOptions
): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 800;
  const imgHeight = metadata.height || 600;

  // Clamp bounding box strictly inside image dimensions
  const bx = Math.max(0, Math.min(imgWidth - 1, Math.round(options.bbox.x)));
  const by = Math.max(0, Math.min(imgHeight - 1, Math.round(options.bbox.y)));
  const bw = Math.max(2, Math.min(imgWidth - bx, Math.round(options.bbox.width)));
  const bh = Math.max(2, Math.min(imgHeight - by, Math.round(options.bbox.height)));

  // Convert full image to raw RGBA buffer for surgical localized manipulation
  const { data: rawBuffer, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const stride = info.width * 4;

  // Sample surrounding border colors (top, bottom, left, right border perimeter)
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let sampleCount = 0;

  const sampleMargin = 4;

  // Sample top and bottom edge perimeter
  for (let x = Math.max(0, bx - sampleMargin); x < Math.min(imgWidth, bx + bw + sampleMargin); x++) {
    // Top border sample
    const yTop = Math.max(0, by - sampleMargin);
    const idxTop = yTop * stride + x * 4;
    rSum += rawBuffer[idxTop];
    gSum += rawBuffer[idxTop + 1];
    bSum += rawBuffer[idxTop + 2];
    sampleCount++;

    // Bottom border sample
    const yBottom = Math.min(imgHeight - 1, by + bh + sampleMargin);
    const idxBottom = yBottom * stride + x * 4;
    rSum += rawBuffer[idxBottom];
    gSum += rawBuffer[idxBottom + 1];
    bSum += rawBuffer[idxBottom + 2];
    sampleCount++;
  }

  // Sample left and right edge perimeter
  for (let y = Math.max(0, by - sampleMargin); y < Math.min(imgHeight, by + bh + sampleMargin); y++) {
    // Left border sample
    const xLeft = Math.max(0, bx - sampleMargin);
    const idxLeft = y * stride + xLeft * 4;
    rSum += rawBuffer[idxLeft];
    gSum += rawBuffer[idxLeft + 1];
    bSum += rawBuffer[idxLeft + 2];
    sampleCount++;

    // Right border sample
    const xRight = Math.min(imgWidth - 1, bx + bw + sampleMargin);
    const idxRight = y * stride + xRight * 4;
    rSum += rawBuffer[idxRight];
    gSum += rawBuffer[idxRight + 1];
    bSum += rawBuffer[idxRight + 2];
    sampleCount++;
  }

  const bgR = Math.round(rSum / Math.max(1, sampleCount));
  const bgG = Math.round(gSum / Math.max(1, sampleCount));
  const bgB = Math.round(bSum / Math.max(1, sampleCount));

  // Inpaint target region using bilateral gradient interpolation from border edges
  for (let y = by; y < by + bh; y++) {
    const yNorm = (y - by) / Math.max(1, bh); // 0.0 to 1.0

    // Sample boundary pixels directly above and below current column
    const topY = Math.max(0, by - 1);
    const botY = Math.min(imgHeight - 1, by + bh);

    for (let x = bx; x < bx + bw; x++) {
      const xNorm = (x - bx) / Math.max(1, bw); // 0.0 to 1.0

      const leftX = Math.max(0, bx - 1);
      const rightX = Math.min(imgWidth - 1, bx + bw);

      const topIdx = topY * stride + x * 4;
      const botIdx = botY * stride + x * 4;
      const leftIdx = y * stride + leftX * 4;
      const rightIdx = y * stride + rightX * 4;

      // Vertical gradient component
      const vr = rawBuffer[topIdx] * (1 - yNorm) + rawBuffer[botIdx] * yNorm;
      const vg = rawBuffer[topIdx + 1] * (1 - yNorm) + rawBuffer[botIdx + 1] * yNorm;
      const vb = rawBuffer[topIdx + 2] * (1 - yNorm) + rawBuffer[botIdx + 2] * yNorm;

      // Horizontal gradient component
      const hr = rawBuffer[leftIdx] * (1 - xNorm) + rawBuffer[rightIdx] * xNorm;
      const hg = rawBuffer[leftIdx + 1] * (1 - xNorm) + rawBuffer[rightIdx + 1] * xNorm;
      const hb = rawBuffer[leftIdx + 2] * (1 - xNorm) + rawBuffer[rightIdx + 2] * xNorm;

      // Blend components
      const interpR = Math.round((vr + hr) / 2);
      const interpG = Math.round((vg + hg) / 2);
      const interpB = Math.round((vb + hb) / 2);

      const targetIdx = y * stride + x * 4;

      // Write reconstructed pixel back only to the target bounding box
      rawBuffer[targetIdx] = interpR;
      rawBuffer[targetIdx + 1] = interpG;
      rawBuffer[targetIdx + 2] = interpB;
      rawBuffer[targetIdx + 3] = 255;
    }
  }

  // Re-encode into the original container format preserving dimensions
  const format = (metadata.format as any) || 'png';
  return await sharp(rawBuffer, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .toFormat(format)
    .toBuffer();
}
