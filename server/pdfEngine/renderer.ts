/**
 * ClearDoc PDF High-Fidelity Server-Side Rendering
 * Uses pdfjs-dist and @napi-rs/canvas to render exact page pixels
 */
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { CONFIG } from '../config.js';
import { getPdfjs, pdfjsDocumentOptions } from './pdfjsLoader.js';

let pdfjsModule: any = null;

export async function renderPageToPng(
  pdfBuffer: Buffer,
  pageNumber: number,
  dpi = 150
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const pdfjs = await getPdfjs();
  
  // Calculate scale factor relative to 72 points per inch standard PDF units
  const scale = dpi / 72.0;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: false,
    ...pdfjsDocumentOptions(),
  });

  const doc = await loadingTask.promise;
  const numPages = doc.numPages;

  if (pageNumber < 1 || pageNumber > numPages) {
    throw new Error(`Page ${pageNumber} out of range (1-${numPages})`);
  }

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  const canvasWidth = Math.max(1, Math.floor(viewport.width));
  const canvasHeight = Math.max(1, Math.floor(viewport.height));

  // Rendered-pixel ceiling: a hostile page-size PDF (huge MediaBox) must fail
  // with a deterministic JSON-mapped error, not a native canvas allocation
  // failure. The check uses the same width×height arithmetic as raster ingest.
  const renderPixels = canvasWidth * canvasHeight;
  if (renderPixels > CONFIG.MAX_RENDER_PIXELS) {
    const err: any = new Error(
      `Rendered page size ${canvasWidth}x${canvasHeight} (${Math.round(renderPixels / 1e6)} MP at ${dpi} dpi) exceeds the ${Math.round(CONFIG.MAX_RENDER_PIXELS / 1e6)} MP limit.`
    );
    err.code = 'RENDER_TOO_LARGE';
    throw err;
  }

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Fill canvas with white background before rendering PDF elements
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  await page.render({
    canvasContext: ctx as any,
    viewport,
    intent: 'print',
  }).promise;

  const buffer = canvas.toBuffer('image/png');
  return { buffer, width: canvasWidth, height: canvasHeight };
}

export async function renderAllPagesToPng(
  pdfBuffer: Buffer,
  dpi = 150
): Promise<Array<{ pageNumber: number; buffer: Buffer; width: number; height: number }>> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    ...pdfjsDocumentOptions(),
  });
  const doc = await loadingTask.promise;
  const total = doc.numPages;
  const results: Array<{ pageNumber: number; buffer: Buffer; width: number; height: number }> = [];

  for (let i = 1; i <= total; i++) {
    const rendered = await renderPageToPng(pdfBuffer, i, dpi);
    results.push({ pageNumber: i, ...rendered });
  }

  return results;
}
