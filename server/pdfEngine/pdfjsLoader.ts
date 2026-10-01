/**
 * Single shared pdfjs loader for all server-side PDF engines
 * (inspector, renderer, verification).
 *
 * `standardFontDataUrl` is a memory-safety requirement, not an optimization:
 * without a path to pdfjs-dist's bundled standard-font data, pdfjs has no
 * loading strategy for non-embedded standard fonts (Helvetica etc.) and falls
 * back to per-operation ad-hoc font synthesis. MEASURED on a single 368 KB
 * text-dense page at 150 dpi: +576 MB RSS without the setting, +4 MB with it —
 * the difference between fitting in and predictably blowing a small host's
 * memory envelope (Render Free 512 MB).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

let pdfjsModule: any = null;
let resolvedStandardFontDataUrl: string | undefined | null = null;

export async function getPdfjs() {
  if (!pdfjsModule) {
    pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModule;
}

/**
 * Resolves the bundled standard_fonts directory as a file URL (pdfjs requires
 * a URL string with a trailing slash). Resolved once per process. If the
 * pdfjs-dist layout ever changes, returns undefined so pdfjs keeps its own
 * defaults — never a broken path.
 */
function resolveStandardFontDataUrl(): string | undefined {
  if (resolvedStandardFontDataUrl !== null) return resolvedStandardFontDataUrl ?? undefined;
  try {
    const require_ = createRequire(import.meta.url);
    const pkgDir = path.dirname(require_.resolve('pdfjs-dist/package.json'));
    const fontsDir = path.join(pkgDir, 'standard_fonts') + path.sep;
    resolvedStandardFontDataUrl = pathToFileURL(fontsDir).href;
  } catch {
    resolvedStandardFontDataUrl = undefined;
  }
  return resolvedStandardFontDataUrl;
}

/** Document options every server-side getDocument() call must include. */
export function pdfjsDocumentOptions(): { useSystemFonts: boolean; standardFontDataUrl?: string } {
  return {
    useSystemFonts: true,
    standardFontDataUrl: resolveStandardFontDataUrl(),
  };
}
