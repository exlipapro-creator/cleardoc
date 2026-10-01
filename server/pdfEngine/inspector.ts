/**
 * ClearDoc PDF Inspection Engine
 * Inspects PDF structure, page geometries, font inventory, text items, and annotations.
 */
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { CONFIG } from '../config.js';
import { pdfjsDocumentOptions } from './pdfjsLoader.js';

let pdfjsModule: any = null;

async function getPdfjs() {
  if (!pdfjsModule) {
    pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModule;
}

export interface ExtractedTextItem {
  page: number;
  text: string;
  fontName: string;
  fontSize: number;
  rotation: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  matrix: number[];
  baselineOrigin: {
    x: number;
    y: number;
  };
}

export interface InspectedPage {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  textItems: ExtractedTextItem[];
  annotationsCount: number;
  linksCount: number;
  imagesCount: number;
  fullText: string;
}

export interface PdfInspectionResult {
  pageCount: number;
  sha256: string;
  dimensions: Array<{ width: number; height: number }>;
  pages: InspectedPage[];
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modificationDate?: string;
  };
  hasFormFields: boolean;
  hasLinks: boolean;
  hasAnnotations: boolean;
  hasNativeText: boolean;
}

export async function inspectPdf(pdfBuffer: Buffer): Promise<PdfInspectionResult> {
  const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

  // Load with pdf-lib for object counts, form fields, and metadata
  const pdfLibDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: false });
  const pageCount = pdfLibDoc.getPageCount();

  const title = pdfLibDoc.getTitle();
  const author = pdfLibDoc.getAuthor();
  const subject = pdfLibDoc.getSubject();
  const keywords = pdfLibDoc.getKeywords();
  const creator = pdfLibDoc.getCreator();
  const producer = pdfLibDoc.getProducer();
  const creationDate = pdfLibDoc.getCreationDate()?.toISOString();
  const modificationDate = pdfLibDoc.getModificationDate()?.toISOString();

  let formFieldCount = 0;
  try {
    const form = pdfLibDoc.getForm();
    formFieldCount = form.getFields().length;
  } catch {
    // No interactive form
  }

  // Load with pdfjs for deep text, font, and geometry inspection
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: false,
    ...pdfjsDocumentOptions(),
  });

  const doc = await loadingTask.promise;
  const inspectedPages: InspectedPage[] = [];
  const dimensions: Array<{ width: number; height: number }> = [];

  let totalTextCount = 0;
  let totalLinks = 0;
  let totalAnnotations = 0;
  // Cumulative text-item count across ALL pages. Enforced against
  // CONFIG.MAX_TEXT_ITEMS DURING extraction (early-stop): render memory on
  // text-dense pages scales with per-page text operations, not file bytes or
  // page count, so a modest-size PDF can otherwise drive multi-hundred-MB
  // renders. Stopping here rejects the document before any preview render.
  let textItemCount = 0;

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });

    const pageWidth = viewport.width;
    const pageHeight = viewport.height;
    dimensions.push({ width: pageWidth, height: pageHeight });

    const textContent = await page.getTextContent({
      includeMarkedContent: false,
    });

    const annotations = await page.getAnnotations();
    const links = annotations.filter((a: any) => a.subtype === 'Link');
    totalAnnotations += annotations.length;
    totalLinks += links.length;

    const pageTextItems: ExtractedTextItem[] = [];
    const textPieces: string[] = [];

    for (const item of textContent.items as any[]) {
      if (!item.str || item.str.trim().length === 0) continue;

      const tx = item.transform; // [a, b, c, d, e, f]
      // Rotation angle in degrees from matrix
      const angleRad = Math.atan2(tx[1], tx[0]);
      let angleDeg = Math.round((angleRad * 180) / Math.PI);
      if (angleDeg < 0) angleDeg += 360;

      // Font size is roughly the scale of the matrix or item.height
      const fontSize = Math.round(
        Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || item.height || 12
      );

      // Coordinates in points
      // In PDF coordinates, origin is bottom-left. In viewport/web coords, origin is top-left.
      // pdfjs viewport.convertToViewportPoint translates to top-left coords:
      const [vx, vy] = viewport.convertToViewportPoint(tx[4], tx[5]);

      const itemWidth = Math.max(1, item.width || (item.str.length * fontSize * 0.6));
      const itemHeight = Math.max(1, item.height || fontSize);

      pageTextItems.push({
        page: i,
        text: item.str,
        fontName: item.fontName || 'Unknown',
        fontSize,
        rotation: angleDeg,
        bbox: {
          x: Math.round(vx),
          y: Math.round(vy - itemHeight),
          width: Math.round(itemWidth),
          height: Math.round(itemHeight),
        },
        matrix: tx,
        baselineOrigin: {
          x: Math.round(vx),
          y: Math.round(vy),
        },
      });

      // Early-stop ceiling: reject pathologically dense documents at
      // inspection time, before the memory-intensive preview renders run.
      if (++textItemCount > CONFIG.MAX_TEXT_ITEMS) {
        try { await loadingTask.destroy(); } catch { /* already torn down */ }
        const err: any = new Error(
          `Document exceeds the supported text density (more than ${CONFIG.MAX_TEXT_ITEMS} text elements by page ${i}).`
        );
        err.code = 'PDF_TOO_COMPLEX';
        throw err;
      }

      textPieces.push(item.str);
      totalTextCount += item.str.length;
    }

    // Rough count of images / XObjects in page
    let imagesCount = 0;
    try {
      const ops = await page.getOperatorList();
      for (let opIdx = 0; opIdx < ops.fnArray.length; opIdx++) {
        // paintImageXObject / paintInlineImageXObject
        const fn = ops.fnArray[opIdx];
        if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
          imagesCount++;
        }
      }
    } catch {
      // Ignored
    }

    inspectedPages.push({
      pageNumber: i,
      width: pageWidth,
      height: pageHeight,
      rotation: viewport.rotation,
      textItems: pageTextItems,
      annotationsCount: annotations.length,
      linksCount: links.length,
      imagesCount,
      fullText: textPieces.join(' '),
    });
  }

  return {
    pageCount,
    sha256,
    dimensions,
    pages: inspectedPages,
    metadata: {
      title,
      author,
      subject,
      keywords,
      creator,
      producer,
      creationDate,
      modificationDate,
    },
    hasFormFields: formFieldCount > 0,
    hasLinks: totalLinks > 0,
    hasAnnotations: totalAnnotations > 0,
    hasNativeText: totalTextCount > 20,
  };
}
