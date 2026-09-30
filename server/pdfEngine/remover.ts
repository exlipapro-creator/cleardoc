/**
 * ClearDoc Native PDF Surgical Removal Engine
 * Performs surgical operator removal on content streams while preserving
 * fonts, forms, hyperlinks, page boxes, and metadata without page rasterization.
 */
import {
  PDFDocument,
  PDFArray,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { RemovalPlan } from '../../shared/types.js';

export interface NativeRemovalResult {
  modifiedPdfBuffer: Buffer;
  removedOperationsCount: number;
  preservedPageCount: number;
}

export async function executeNativeRemoval(
  originalPdfBuffer: Buffer,
  plan: RemovalPlan
): Promise<NativeRemovalResult> {
  const pdfDoc = await PDFDocument.load(originalPdfBuffer, { ignoreEncryption: false });
  const totalPages = pdfDoc.getPageCount();
  let totalOperationsRemoved = 0;

  // Group operations by page (1-indexed)
  const opsByPage = new Map<number, typeof plan.operations>();
  for (const op of plan.operations) {
    const list = opsByPage.get(op.page) || [];
    list.push(op);
    opsByPage.set(op.page, list);
  }

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageOps = opsByPage.get(pageNum);
    if (!pageOps || pageOps.length === 0) continue;

    const page = pdfDoc.getPage(pageNum - 1);
    const targetTexts: string[] = [];

    for (const op of pageOps) {
      if (op.operation === 'REMOVE_TEXT_OBJECT' && op.details?.text) {
        targetTexts.push(String(op.details.text).trim());
      }
    }

    if (targetTexts.length === 0) continue;

    // Access the page's content stream(s)
    const contentsRef = page.node.Contents();
    if (!contentsRef) continue;

    // Helper to process a raw stream and return replacement flateStream if modified
    const processStream = (rawStream: PDFRawStream) => {
      const decodedBytes = decodePDFRawStream(rawStream).decode();
      let streamStr = new TextDecoder('latin1').decode(decodedBytes);
      let streamModified = false;

      // Match blocks: optional 'q', 'BT', ..., 'ET', optional 'Q'
      const blockRegex = /(?:q\s*)?BT\b([\s\S]*?)\bET(?:\s*Q)?/g;

      const newStreamStr = streamStr.replace(blockRegex, (fullMatch, textContent) => {
        const matchesTarget = targetTexts.some((target) => {
          if (!target) return false;

          // 1. Literal ascii match: (DRAFT)
          if (textContent.includes(`(${target})`)) return true;

          // 2. Case-insensitive inner string match
          const parenMatches = textContent.match(/\(([^)]+)\)/g);
          if (parenMatches) {
            for (const p of parenMatches) {
              const inner = p.slice(1, -1);
              if (inner.toUpperCase().includes(target.toUpperCase())) {
                return true;
              }
            }
          }

          // 3. Hexadecimal encoded text: <4452414654>
          const hexTarget = Buffer.from(target, 'utf8').toString('hex').toUpperCase();
          if (textContent.toUpperCase().includes(hexTarget)) return true;

          // 4. Hex string within angle brackets
          const hexMatches = textContent.match(/<([0-9a-fA-F]+)>/g);
          if (hexMatches) {
            for (const h of hexMatches) {
              const hexVal = h.slice(1, -1);
              try {
                const decodedStr = Buffer.from(hexVal, 'hex').toString('latin1');
                if (decodedStr.toUpperCase().includes(target.toUpperCase())) {
                  return true;
                }
              } catch {
                // Ignore hex decode failure
              }
            }
          }

          // 5. Array text: [(D) 10 (R) ...]
          if (textContent.includes('[') && textContent.includes(']')) {
            const reconstructed = textContent
              .replace(/\[|\]/g, '')
              .replace(/\(([^)]*)\)/g, '$1')
              .replace(/-?\d+(\.\d+)?/g, '')
              .replace(/\s+/g, '');
            if (reconstructed.toUpperCase().includes(target.toUpperCase())) {
              return true;
            }
          }

          return false;
        });

        if (matchesTarget) {
          streamModified = true;
          totalOperationsRemoved++;
          // Replace with clean no-op comment
          return '% ClearDoc: surgical watermark removal';
        }

        return fullMatch;
      });

      if (streamModified) {
        const newBytes = new TextEncoder().encode(newStreamStr);
        return pdfDoc.context.flateStream(newBytes);
      }
      return null;
    };

    if (contentsRef instanceof PDFArray) {
      for (let idx = 0; idx < contentsRef.size(); idx++) {
        const item = contentsRef.get(idx);
        let rawStream: PDFRawStream | null = null;
        if (item instanceof PDFRef) {
          const lookedUp = pdfDoc.context.lookup(item);
          if (lookedUp instanceof PDFRawStream) rawStream = lookedUp;
        } else if (item instanceof PDFRawStream) {
          rawStream = item;
        }

        if (rawStream) {
          const newStream = processStream(rawStream);
          if (newStream) {
            const newRef = pdfDoc.context.register(newStream);
            contentsRef.set(idx, newRef);
          }
        }
      }
    } else if (contentsRef instanceof PDFRef) {
      const lookedUp = pdfDoc.context.lookup(contentsRef);
      if (lookedUp instanceof PDFRawStream) {
        const newStream = processStream(lookedUp);
        if (newStream) {
          const newRef = pdfDoc.context.register(newStream);
          page.node.set(pdfDoc.context.obj('Contents'), newRef);
        }
      }
    } else if (contentsRef instanceof PDFRawStream) {
      const newStream = processStream(contentsRef);
      if (newStream) {
        const newRef = pdfDoc.context.register(newStream);
        page.node.set(pdfDoc.context.obj('Contents'), newRef);
      }
    }
  }

  const modifiedBytes = await pdfDoc.save({ useObjectStreams: false });
  return {
    modifiedPdfBuffer: Buffer.from(modifiedBytes),
    removedOperationsCount: totalOperationsRemoved,
    preservedPageCount: totalPages,
  };
}
