/**
 * ClearDoc API Routes & Orchestration
 * Enforces session security, magic-byte checks, honest state transitions, and verification gating.
 */
import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from './config.js';
import { storageService } from './storage.js';
import { db } from './db.js';
import {
  DocumentRecord,
  AnalysisRecord,
  JobRecord,
  ManualRegion,
  RemovalStrategy,
} from '../shared/types.js';
import { inspectPdf } from './pdfEngine/inspector.js';
import { detectPdfWatermarks } from './pdfEngine/detector.js';
import { renderPageToPng } from './pdfEngine/renderer.js';
import { constructRemovalPlan } from './pdfEngine/planner.js';
import { executeNativeRemoval } from './pdfEngine/remover.js';
import { verifyProcessedPdf } from './verificationEngine/verifier.js';
import { processRasterWatermark } from './rasterEngine/processor.js';
import { detectRasterWatermarks } from './rasterEngine/detector.js';
import { verifyProcessedRaster } from './rasterEngine/verifier.js';
import { pipelineGate } from './pipeline.js';
import {
  generateDraftPdfFixture,
  generateConfidentialPdfFixture,
  generateCleanPdfFixture,
  generateSampleImageFixture,
} from './fixtures.js';

export const apiRouter = express.Router();

// Memory storage for incoming uploads before magic-byte quarantine
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE_BYTES,
  },
});

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per session) for expensive operations.
// Protects CPU-heavy engines from abusive or runaway clients.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const sessionId = (req as any).sessionId as string;
  const now = Date.now();
  const bucket = rateBuckets.get(sessionId);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(sessionId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait a moment before trying again.',
      },
    });
    return;
  }
  next();
}

// Periodically drop stale rate-limit buckets to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// Middleware to extract or establish secure temporary session
function resolveSession(req: Request, res: Response, next: NextFunction) {
  let sessionId = req.headers['x-session-id'] as string;
  if (!sessionId || !/^[a-zA-Z0-9_-]{10,64}$/.test(sessionId)) {
    sessionId = `sess_${crypto.randomBytes(16).toString('hex')}`;
  }
  (req as any).sessionId = sessionId;
  res.setHeader('x-session-id', sessionId);
  next();
}

apiRouter.use(resolveSession);

// Apply limiter AFTER session resolution so buckets are keyed per session
// (keying before this point would bucket every request under `undefined`,
// making the limiter global and letting one client lock out all others).
apiRouter.use(rateLimit);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Maps known engine failure codes to customer-facing messages. */
function mapUploadError(err: Error): { status: number; code: string; message: string } {
  switch (err.message) {
    case 'FILE_TOO_LARGE':
      return {
        status: 413,
        code: 'FILE_TOO_LARGE',
        message: `File exceeds the maximum size of ${Math.round(CONFIG.MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`,
      };
    case 'IMAGE_TOO_LARGE':
      return {
        status: 413,
        code: 'IMAGE_TOO_LARGE',
        message: `Image exceeds the maximum resolution of ${Math.round(CONFIG.MAX_IMAGE_PIXELS / 1e6)} megapixels.`,
      };
    case 'PDF_IMAGE_TOO_LARGE':
      return {
        status: 413,
        code: 'PDF_IMAGE_TOO_LARGE',
        message: `A page in this document embeds more than ${Math.round(CONFIG.MAX_PDF_IMAGE_PIXELS_PER_PAGE / 1e6)} MP of image data. Nothing was changed.`,
      };
    case 'PROCESSING_DEADLINE_EXCEEDED':
      // Ingest/analyze-stage deadline: the document could not be prepared
      // within the server's processing budget. Honest, deterministic failure.
      return {
        status: 400,
        code: 'PROCESSING_TIMEOUT',
        message: 'This document could not be prepared for review in time. Please try a smaller or simpler document.',
      };
    case 'UNSUPPORTED_FORMAT':
      return {
        status: 415,
        code: 'UNSUPPORTED_FORMAT',
        message: 'Unsupported file format. ClearDoc accepts PDF documents and standard images (PNG, JPEG, WEBP, TIFF).',
      };
    case 'PDF_TOO_COMPLEX':
      return {
        status: 400,
        code: 'PDF_TOO_COMPLEX',
        message: 'This document is too text-dense to process safely. Nothing was changed — please try a flattened or scanned copy.',
      };
    case 'RENDER_TOO_LARGE':
      return {
        status: 413,
        code: 'RENDER_TOO_LARGE',
        message: 'A page in this document is too large to render at the supported resolution. Nothing was changed.',
      };
    case 'INVALID_SESSION_IDENTIFIER':
      return { status: 400, code: 'INVALID_SESSION_IDENTIFIER', message: 'Invalid session identifier.' };
    default:
      return {
        status: 400,
        code: 'UPLOAD_FAILED',
        message: 'Could not safely read this document. It may be corrupted or password-protected.',
      };
  }
}

/** Removes control characters from user-supplied filenames used in download headers. */
function sanitizeContentDispositionFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\]/g, '_').replace(/[\x00-\x1F]/g, '');
  return cleaned.length > 0 ? cleaned : 'document';
}

/** Creates a DocumentRecord after validation and persists preview render. */
async function ingestDocument(
  sessionId: string,
  filename: string,
  buffer: Buffer
): Promise<DocumentRecord> {
  const stored = await storageService.storeUpload(sessionId, filename, buffer);
  const paths = storageService.getSessionPaths(sessionId);

  let pageCount = 1;
  let dimensions: Array<{ width: number; height: number }> = [];

  if (stored.mimeType === 'application/pdf') {
    const inspection = await inspectPdf(buffer);
    pageCount = inspection.pageCount;
    dimensions = inspection.dimensions;

    if (pageCount > CONFIG.MAX_PAGE_COUNT) {
      // Clean the just-stored file before failing
      await storageService.deleteSession(sessionId).catch(() => undefined);
      const err: any = new Error(`Document has ${pageCount} pages. Maximum allowed is ${CONFIG.MAX_PAGE_COUNT}.`);
      err.code = 'PAGE_LIMIT_EXCEEDED';
      err.status = 400;
      throw err;
    }

    // Generate page 1 preview render immediately. Deadline-bounded like
    // processing: the ingest render is memory-intensive and must not become
    // an unbounded (gate-free) CPU/memory path.
    const rendered = await withDeadline(
      renderPageToPng(buffer, 1, CONFIG.PREVIEW_DPI),
      Date.now() + CONFIG.PROCESSING_DEADLINE_MS
    );
    const previewPath = path.join(paths.previewsDir, `orig_p1.png`);
    await fs.promises.writeFile(previewPath, rendered.buffer);
  } else {
    const meta = await sharp(buffer).metadata();
    dimensions = [{ width: meta.width || 800, height: meta.height || 600 }];

    // Raster resource control: reject images whose decoded pixel count exceeds
    // the configured ceiling. This bounds analysis/processing memory+CPU at the
    // front door instead of relying on the processing deadline alone.
    const decodedPixels = (meta.width || 0) * (meta.height || 0);
    if (decodedPixels > CONFIG.MAX_IMAGE_PIXELS) {
      await storageService.deleteSession(sessionId).catch(() => undefined);
      const err: any = new Error(
        `Image is ${meta.width}x${meta.height} (${Math.round(decodedPixels / 1e6)} MP). Maximum is ${Math.round(CONFIG.MAX_IMAGE_PIXELS / 1e6)} MP.`
      );
      err.code = 'IMAGE_TOO_LARGE';
      err.status = 413;
      throw err;
    }

    const previewBuffer = await sharp(buffer).png().toBuffer();
    await fs.promises.writeFile(path.join(paths.previewsDir, `orig_p1.png`), previewBuffer);
  }

  const now = new Date();
  return {
    id: stored.fileId,
    sessionId,
    originalFilename: filename,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    pageCount,
    dimensions,
    status: 'UPLOADED',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CONFIG.RETENTION_MS).toISOString(),
  };
}

/** Locates the stored original file for a document. */
async function findOriginalFilePath(sessionId: string, documentId: string): Promise<string | null> {
  const paths = storageService.getSessionPaths(sessionId);
  const files = await fs.promises.readdir(paths.originalDir);
  const target = files.find((f) => f.startsWith(documentId));
  return target ? path.join(paths.originalDir, target) : null;
}

/**
 * Races a processing promise against the job deadline so pathological documents
 * surface as PROCESSING_FAILED instead of hanging the worker indefinitely.
 */
function withDeadline<T>(p: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error('PROCESSING_DEADLINE_EXCEEDED'));
  }
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error('PROCESSING_DEADLINE_EXCEEDED')), remaining);
      t.unref?.();
    }),
  ]);
}

/** Reads the output file for a document, keyed by document id. */
function findOutputFilePath(sessionId: string, documentId: string): string | null {
  const paths = storageService.getSessionPaths(sessionId);
  const files = fs.readdirSync(paths.outputDir);
  const target = files.find((f) => f.startsWith(`cleaned_${documentId}`));
  return target ? path.join(paths.outputDir, target) : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/documents
 * Accepts document upload, validates magic bytes, inspects structure, renders initial preview
 */
apiRouter.post('/documents', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: { code: 'NO_FILE_PROVIDED', message: 'No document file uploaded.' } });
      return;
    }

    const sessionId = (req as any).sessionId;
    const documentRecord = await ingestDocument(sessionId, file.originalname, file.buffer);
    db.saveDocument(documentRecord);

    res.status(201).json({ document: documentRecord, sessionId });
  } catch (err: any) {
    console.error('[Upload Error]:', err);
    // Ingest-time rejections that occur AFTER the file was quarantined to
    // storage must clean the session immediately (privacy + disk hygiene);
    // GC would otherwise hold the rejected original for the full retention
    // window.
    if (err?.code === 'PDF_TOO_COMPLEX' || err?.code === 'RENDER_TOO_LARGE' || err?.code === 'PDF_IMAGE_TOO_LARGE') {
      const sid = (req as any).sessionId;
      if (sid) await storageService.deleteSession(sid).catch(() => undefined);
    }
    const mapped = mapUploadError(err);
    const status = typeof err.status === 'number' ? err.status : mapped.status;
    const code = err.code || mapped.code;
    const message = err.code || err.status ? err.message : mapped.message;
    res.status(status).json({ error: { code, message } });
  }
});

/**
 * POST /api/documents/:id/analyze
 * Inspects document internal structure and detects watermark candidates.
 * For images, runs real pixel-based background deviation analysis.
 */
apiRouter.post('/documents/:id/analyze', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const sessionId = (req as any).sessionId;
    const doc = db.getDocument(id, sessionId);

    if (!doc) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found or expired.' } });
      return;
    }

    // Re-analysis is only meaningful from UPLOADED or after a failed attempt.
    if (doc.status !== 'UPLOADED' && doc.status !== 'ANALYSIS_FAILED') {
      res.status(409).json({
        error: {
          code: 'INVALID_STATE',
          message: 'This document has already been analyzed.',
        },
      });
      return;
    }

    if (!db.updateDocumentStatus(id, 'ANALYZING')) {
      res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Document cannot be analyzed in its current state.' } });
      return;
    }

    const originalFilePath = await findOriginalFilePath(sessionId, id);
    if (!originalFilePath) {
      db.updateDocumentStatus(id, 'ANALYSIS_FAILED', { errorMessage: 'Original file missing' });
      res.status(500).json({ error: { code: 'FILE_NOT_FOUND', message: 'File was deleted or lost.' } });
      return;
    }

    const buffer = await fs.promises.readFile(originalFilePath);
    const paths = storageService.getSessionPaths(sessionId);

    let candidates = [];
    let summary = '';
    let hasNativeContent = true;
    let isRasterOnly = false;

    if (doc.mimeType === 'application/pdf') {
      const inspection = await inspectPdf(buffer);
      hasNativeContent = inspection.hasNativeText;
      isRasterOnly = !inspection.hasNativeText && inspection.pages.some((p) => p.imagesCount > 0);

      const detection = detectPdfWatermarks(inspection);
      candidates = detection.candidates;
      summary = detection.summary;

      // Render previews for all pages (deadline-bounded like processing)
      const analyzeDeadline = Date.now() + CONFIG.PROCESSING_DEADLINE_MS;
      for (let p = 1; p <= doc.pageCount; p++) {
        const previewPath = path.join(paths.previewsDir, `orig_p${p}.png`);
        if (!fs.existsSync(previewPath)) {
          const rendered = await withDeadline(
            renderPageToPng(buffer, p, CONFIG.PREVIEW_DPI),
            analyzeDeadline
          );
          await fs.promises.writeFile(previewPath, rendered.buffer);
        }
      }
    } else {
      // Real pixel-based raster analysis (no fabricated regions)
      isRasterOnly = true;
      hasNativeContent = false;

      const detection = await detectRasterWatermarks(buffer);
      candidates = detection.candidates;
      summary = detection.summary;
    }

    const analysisHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(candidates))
      .digest('hex');

    const analysisRecord: AnalysisRecord = {
      id: `analysis_${uuidv4()}`,
      documentId: id,
      engineVersion: CONFIG.ENGINE_VERSIONS.detector,
      analysisHash,
      candidates,
      pageCount: doc.pageCount,
      hasNativeContent,
      isRasterOnly,
      summary,
      createdAt: new Date().toISOString(),
    };

    db.saveAnalysis(analysisRecord);
    db.updateDocumentStatus(id, 'AWAITING_REVIEW', { analysisId: analysisRecord.id });

    res.json({
      document: db.getDocument(id),
      analysis: analysisRecord,
    });
  } catch (err: any) {
    console.error('[Analyze Error]:', err);
    db.updateDocumentStatus(req.params.id, 'ANALYSIS_FAILED', { errorMessage: err.message });
    res.status(500).json({
      error: {
        code: 'ANALYSIS_FAILED',
        message: 'Document structure analysis failed. The document may be corrupted or malformed.',
      },
    });
  }
});

/**
 * GET /api/documents/:id
 */
apiRouter.get('/documents/:id', (req: Request, res: Response): void => {
  const { id } = req.params;
  const sessionId = (req as any).sessionId;
  const doc = db.getDocument(id, sessionId);
  if (!doc) {
    res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
    return;
  }
  res.json({ document: doc });
});

/**
 * GET /api/documents/:id/analysis
 * Session-scoped: returns only analyses belonging to the caller's session.
 */
apiRouter.get('/documents/:id/analysis', (req: Request, res: Response): void => {
  const { id } = req.params;
  const sessionId = (req as any).sessionId;

  const doc = db.getDocument(id, sessionId);
  if (!doc) {
    res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
    return;
  }

  const analysis = db.getAnalysisByDocumentId(id);
  if (!analysis) {
    res.status(404).json({ error: { code: 'ANALYSIS_NOT_FOUND', message: 'Analysis not found.' } });
    return;
  }
  res.json({ analysis });
});

/**
 * POST /api/documents/:id/process (handler)
 * Executes removal plan and independent verification.
 * For PDFs: native surgical content-stream removal + pixel/structural verification.
 * For images: localized raster restoration + real measured pixel-diff verification.
 */
async function handleProcessRequest(req: Request, res: Response): Promise<void> {
  let jobId = '';
  let documentId = req.params.id;
  try {
    const { id } = req.params;
    documentId = id;
    const sessionId = (req as any).sessionId;
    const doc = db.getDocument(id, sessionId);

    if (!doc) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
      return;
    }

    // Guard against double-submission: processing requires a reviewable state or an
    // explicit retry from a failed attempt (the state machine permits
    // PROCESSING_FAILED/VERIFICATION_FAILED -> PROCESSING). Re-processing after
    // completion is rejected (upload a fresh copy to retry).
    if (
      doc.status !== 'AWAITING_REVIEW' &&
      doc.status !== 'REVIEW_REQUIRED' &&
      doc.status !== 'PROCESSING_FAILED' &&
      doc.status !== 'VERIFICATION_FAILED'
    ) {
      res.status(409).json({
        error: {
          code: 'INVALID_STATE',
          message:
            doc.status === 'PROCESSING' || doc.status === 'VERIFYING'
              ? 'This document is already being processed.'
              : 'This document cannot be processed in its current state. Please upload it again to start over.',
        },
      });
      return;
    }

    const {
      selectedCandidateIds = [],
      manualRegions = [],
      preferredStrategy,
    }: {
      selectedCandidateIds?: string[];
      manualRegions?: ManualRegion[];
      preferredStrategy?: RemovalStrategy;
    } = req.body || {};

    const analysis = db.getAnalysisByDocumentId(id);
    if (!analysis) {
      res.status(400).json({ error: { code: 'NOT_ANALYZED', message: 'Document must be analyzed first.' } });
      return;
    }

    const selectedCandidates = analysis.candidates.filter((c) =>
      selectedCandidateIds.includes(c.id)
    );

    if (selectedCandidates.length === 0 && manualRegions.length === 0) {
      res.status(400).json({
        error: {
          code: 'NO_TARGET_SELECTED',
          message: 'Please select at least one detected watermark or define a manual region to remove.',
        },
      });
      return;
    }

    // Manual regions are only implemented for raster images. For PDFs they would be
    // silently ignored by the native engine, so reject them honestly instead.
    if (doc.mimeType === 'application/pdf' && manualRegions.length > 0) {
      res.status(400).json({
        error: {
          code: 'MANUAL_REGIONS_UNSUPPORTED',
          message: 'Manual regions are not yet supported for PDF documents. Select a detected watermark instead.',
        },
      });
      return;
    }

    jobId = `job_${uuidv4()}`;

    // Claim the document atomically BEFORE registering the job so a losing
    // concurrent request cannot leave an orphaned RUNNING job behind. The
    // claim CAS-checks the status this request observed, so behind a load
    // balancer exactly one instance can win — the loser reports 409.
    if (!db.claimDocument(id, doc.status, 'PROCESSING', { lastJobId: jobId })) {
      res.status(409).json({
        error: { code: 'INVALID_STATE', message: 'Document cannot be processed in its current state.' },
      });
      return;
    }

    const jobRecord: JobRecord = {
      id: jobId,
      documentId: id,
      strategy: preferredStrategy || 'NATIVE_OBJECT_REMOVAL',
      engineVersion: CONFIG.ENGINE_VERSIONS.pdfEngine,
      status: 'RUNNING',
      step: 'CONSTRUCTING_REMOVAL_PLAN',
      progressPercentage: 15,
      startedAt: new Date().toISOString(),
    };
    db.saveJob(jobRecord);

    const paths = storageService.getSessionPaths(sessionId);
    const originalFilePath = await findOriginalFilePath(sessionId, id);
    if (!originalFilePath) throw new Error('ORIGINAL_FILE_MISSING');

    const originalBuffer = await fs.promises.readFile(originalFilePath);

    const plan = constructRemovalPlan(id, selectedCandidates, manualRegions, preferredStrategy);

    // Processing deadline: a pathological document must not hang a job forever.
    // The race rejection is asynchronous (PDF/JS engines cannot be preempted
    // mid-parse), so the HTTP client may see a timeout first — either way the job
    // ends FAILED and the document is never left in a false COMPLETED state.
    const PROCESSING_DEADLINE_MS = CONFIG.PROCESSING_DEADLINE_MS;
    const deadlineAt = Date.now() + PROCESSING_DEADLINE_MS;

    let cleanedBuffer: Buffer;

    if (doc.mimeType === 'application/pdf') {
      db.updateJob(jobId, { step: 'EXECUTING_NATIVE_SURGICAL_REMOVAL', progressPercentage: 45 });
      const removalResult = await withDeadline(executeNativeRemoval(originalBuffer, plan), deadlineAt);
      cleanedBuffer = removalResult.modifiedPdfBuffer;

      // Save output keyed by document id (enables multi-document sessions)
      const outputFilename = `cleaned_${id}.pdf`;
      await fs.promises.writeFile(path.join(paths.outputDir, outputFilename), cleanedBuffer);

      // Render cleaned page previews
      db.updateJob(jobId, { step: 'RENDERING_VERIFICATION_FRAMES', progressPercentage: 65 });
      for (let p = 1; p <= doc.pageCount; p++) {
        const cleanedRender = await renderPageToPng(cleanedBuffer, p, CONFIG.PREVIEW_DPI);
        await fs.promises.writeFile(path.join(paths.previewsDir, `cleaned_p${p}.png`), cleanedRender.buffer);
      }

      // Independent Multi-Dimensional Verification
      db.updateJob(jobId, { step: 'RUNNING_INDEPENDENT_VERIFICATION', progressPercentage: 85 });
      db.updateDocumentStatus(id, 'VERIFYING');

      const { verification, diffPngBuffers } = await withDeadline(verifyProcessedPdf({
        jobId,
        documentId: id,
        originalBuffer,
        cleanedBuffer,
        plan,
        targetCandidates: selectedCandidates,
      }), deadlineAt);

      for (const [pNum, diffBuf] of diffPngBuffers.entries()) {
        await fs.promises.writeFile(path.join(paths.previewsDir, `diff_p${pNum}.png`), diffBuf);
      }

      db.saveVerification(verification);

      if (verification.status === 'PASS') {
        db.updateDocumentStatus(id, 'COMPLETED');
        db.updateJob(jobId, {
          status: 'COMPLETED',
          step: 'VERIFICATION_PASSED',
          progressPercentage: 100,
          completedAt: new Date().toISOString(),
          verificationId: verification.id,
          verificationStatus: 'PASS',
        });
      } else if (verification.status === 'REVIEW') {
        db.updateDocumentStatus(id, 'REVIEW_REQUIRED');
        db.updateJob(jobId, {
          status: 'COMPLETED',
          step: 'AWAITING_USER_VERIFICATION_REVIEW',
          progressPercentage: 100,
          completedAt: new Date().toISOString(),
          verificationId: verification.id,
          verificationStatus: 'REVIEW',
        });
      } else {
        db.updateDocumentStatus(id, 'VERIFICATION_FAILED');
        db.updateJob(jobId, {
          status: 'FAILED',
          step: 'VERIFICATION_FAILED',
          errorCode: 'VERIFICATION_GATE_REJECTED',
          errorMessage: 'The resulting document failed safety verification checks.',
          completedAt: new Date().toISOString(),
          verificationId: verification.id,
          verificationStatus: 'FAIL',
        });
      }

      res.json({
        job: db.getJob(jobId, sessionId),
        verification,
        document: db.getDocument(id),
      });
    } else {
      // Raster image removal
      db.updateJob(jobId, { step: 'EXECUTING_LOCALIZED_RASTER_RESTORATION', progressPercentage: 50 });
      const targetBbox = selectedCandidates[0]?.bbox ||
        manualRegions[0]?.bbox;

      if (!targetBbox) {
        throw new Error('NO_TARGET_GEOMETRY');
      }

      cleanedBuffer = await withDeadline(processRasterWatermark(originalBuffer, {
        bbox: { x: targetBbox.x, y: targetBbox.y, width: targetBbox.width, height: targetBbox.height },
      }), deadlineAt);

      // Preserve original container format so downloads keep their type
      const ext = doc.originalFilename.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const outputFilename = `cleaned_${id}.${ext}`;
      await fs.promises.writeFile(path.join(paths.outputDir, outputFilename), cleanedBuffer);

      const cleanedPreview = await sharp(cleanedBuffer).png().toBuffer();
      await fs.promises.writeFile(path.join(paths.previewsDir, `cleaned_p1.png`), cleanedPreview);

      db.updateJob(jobId, { step: 'RUNNING_INDEPENDENT_VERIFICATION', progressPercentage: 85 });
      db.updateDocumentStatus(id, 'VERIFYING');

      const { verification: rasterVerification } = await withDeadline(verifyProcessedRaster({
        jobId,
        documentId: id,
        originalBuffer,
        cleanedBuffer,
        targetBbox: { x: targetBbox.x, y: targetBbox.y, width: targetBbox.width, height: targetBbox.height },
      }), deadlineAt);

      db.saveVerification(rasterVerification);

      if (rasterVerification.status === 'PASS') {
        db.updateDocumentStatus(id, 'COMPLETED');
      } else if (rasterVerification.status === 'REVIEW') {
        db.updateDocumentStatus(id, 'REVIEW_REQUIRED');
      } else {
        db.updateDocumentStatus(id, 'VERIFICATION_FAILED');
      }

      db.updateJob(jobId, {
        status: rasterVerification.status === 'FAIL' ? 'FAILED' : 'COMPLETED',
        step: rasterVerification.status === 'PASS' ? 'VERIFICATION_PASSED' : rasterVerification.status === 'REVIEW' ? 'AWAITING_USER_VERIFICATION_REVIEW' : 'VERIFICATION_FAILED',
        progressPercentage: 100,
        completedAt: new Date().toISOString(),
        verificationId: rasterVerification.id,
        verificationStatus: rasterVerification.status,
        ...(rasterVerification.status === 'FAIL'
          ? {
              errorCode: 'VERIFICATION_GATE_REJECTED',
              errorMessage: 'The resulting image failed safety verification checks.',
            }
          : {}),
      });

      res.json({
        job: db.getJob(jobId, sessionId),
        verification: rasterVerification,
        document: db.getDocument(id),
      });
    }
  } catch (err: any) {
    console.error('[Process Error]:', err);
    if (jobId) {
      db.updateJob(jobId, {
        status: 'FAILED',
        step: 'FAILED',
        errorCode: err.message || 'PROCESSING_FAILED',
        errorMessage: err.message || 'Watermark removal failed during surgical processing.',
        completedAt: new Date().toISOString(),
      });
    }
    if (documentId) {
      // Use the legal failure state for wherever the pipeline was when it threw:
      // VERIFYING may only transition to VERIFICATION_FAILED; anything earlier
      // maps to PROCESSING_FAILED. Both remain retryable.
      const failureState =
        db.getDocument(documentId)?.status === 'VERIFYING' ? 'VERIFICATION_FAILED' : 'PROCESSING_FAILED';
      db.updateDocumentStatus(documentId, failureState, { errorMessage: err.message });
    }
    res.status(500).json({
      error: {
        code: 'PROCESSING_FAILED',
        message: 'Watermark removal failed during processing. You can retry processing from the review screen.',
      },
    });
  }
}

/**
 * POST /api/documents/:id/process — route with memory-safety admission gate.
 * Expensive processing runs through a bounded in-process semaphore so
 * concurrent pipelines cannot multiply peak memory toward OOM on a small
 * host (measured: a single large raster pipeline is a large fraction of a
 * Render Free instance's RAM). Rejected excess work gets an honest,
 * deterministic 503 SERVICE_BUSY with Retry-After — never a hang, and the
 * slot is always released (success/failure/throw/timeout).
 */
apiRouter.post('/documents/:id/process', async (req: Request, res: Response): Promise<void> => {
  const slot = await pipelineGate.acquire();
  if (!slot.ok) {
    res.setHeader('Retry-After', '3');
    res.status(503).json({
      error: {
        code: 'SERVICE_BUSY',
        message: 'The document processor is already working on another document. Please retry in a few seconds.',
      },
    });
    return;
  }
  try {
    await handleProcessRequest(req, res);
  } finally {
    slot.release();
  }
});

/**
 * POST /api/documents/:id/approve-review
 * Approves a document classified as REVIEW_REQUIRED
 */
apiRouter.post('/documents/:id/approve-review', (req: Request, res: Response): void => {
  const { id } = req.params;
  const sessionId = (req as any).sessionId;
  const doc = db.getDocument(id, sessionId);

  if (!doc) {
    res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
    return;
  }

  if (doc.status !== 'REVIEW_REQUIRED') {
    res.status(400).json({
      error: { code: 'INVALID_STATE', message: 'Document does not require approval review.' },
    });
    return;
  }

  db.updateDocumentStatus(id, 'COMPLETED');
  res.json({ document: db.getDocument(id) });
});

/**
 * GET /api/jobs/:id
 * Session-scoped to prevent cross-session job metadata disclosure.
 */
apiRouter.get('/jobs/:id', (req: Request, res: Response): void => {
  const { id } = req.params;
  const sessionId = (req as any).sessionId;
  const job = db.getJob(id, sessionId);
  if (!job) {
    res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } });
    return;
  }
  const verification = job.verificationId ? db.getVerification(job.verificationId) : null;
  res.json({ job, verification });
});

/**
 * GET /api/documents/:id/preview/:page
 * Query: type=original|cleaned|diff
 */
apiRouter.get('/documents/:id/preview/:page', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, page } = req.params;
    const type = (req.query.type as string) || 'original';
    const sessionId = (req as any).sessionId;
    const doc = db.getDocument(id, sessionId);

    if (!doc) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
      return;
    }

    const pageNum = parseInt(page, 10);
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > doc.pageCount) {
      res.status(400).json({ error: { code: 'INVALID_PAGE', message: 'Invalid page number.' } });
      return;
    }

    const paths = storageService.getSessionPaths(sessionId);
    let filename = `orig_p${pageNum}.png`;
    if (type === 'cleaned') {
      filename = `cleaned_p${pageNum}.png`;
    } else if (type === 'diff') {
      filename = `diff_p${pageNum}.png`;
    } else if (type !== 'original') {
      res.status(400).json({ error: { code: 'INVALID_PREVIEW_TYPE', message: 'Preview type must be original, cleaned, or diff.' } });
      return;
    }

    const previewPath = path.join(paths.previewsDir, filename);
    if (!fs.existsSync(previewPath)) {
      res.status(404).json({ error: { code: 'PREVIEW_NOT_FOUND', message: 'Preview not available yet.' } });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(previewPath).pipe(res);
  } catch (err) {
    console.error('[Preview Error]:', err);
    res.status(500).json({ error: { code: 'PREVIEW_FAILED', message: 'Error reading preview.' } });
  }
});

/**
 * GET /api/documents/:id/download
 * Strict gate: only succeeds when document status is COMPLETED
 */
apiRouter.get('/documents/:id/download', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const sessionId = (req as any).sessionId;
    const doc = db.getDocument(id, sessionId);

    if (!doc) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' } });
      return;
    }

    // Release gate check
    if (doc.status !== 'COMPLETED') {
      res.status(403).json({
        error: {
          code: 'DOWNLOAD_GATED',
          message: 'Downloads are only available after verification passes or an approved review.',
        },
      });
      return;
    }

    const outputFilePath = findOutputFilePath(sessionId, id);
    if (!outputFilePath) {
      res.status(500).json({ error: { code: 'FILE_MISSING', message: 'Processed output file not found.' } });
      return;
    }

    // Extension derived from the validated output file, not user input
    const outputExt = path.extname(outputFilePath) || '.bin';
    const baseName = path.basename(doc.originalFilename, path.extname(doc.originalFilename));
    const cleanFilename = sanitizeContentDispositionFilename(`cleardoc_${baseName}${outputExt}`);

    const outputMime =
      outputExt === '.png' ? 'image/png'
      : outputExt === '.jpg' || outputExt === '.jpeg' ? 'image/jpeg'
      : outputExt === '.webp' ? 'image/webp'
      : outputExt === '.tiff' || outputExt === '.tif' ? 'image/tiff'
      : 'application/pdf';

    res.setHeader('Content-Type', outputMime);
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    fs.createReadStream(outputFilePath).pipe(res);
  } catch (err: any) {
    console.error('[Download Error]:', err);
    res.status(500).json({ error: { code: 'DOWNLOAD_FAILED', message: 'Download failed.' } });
  }
});

/**
 * POST /api/fixtures/create-sample
 * Generates real, reproducible sample documents (clearly labeled as samples in the UI)
 * for immediate testing and for demonstrating honest no-false-positive detection.
 */
apiRouter.post('/fixtures/create-sample', async (req: Request, res: Response): Promise<void> => {
  try {
    const { fixtureType = 'draft' } = req.body || {};
    const sessionId = (req as any).sessionId;

    let buffer: Buffer;
    let filename: string;
    let mimeType = 'application/pdf';

    if (fixtureType === 'draft') {
      buffer = await generateDraftPdfFixture();
      filename = 'Quarterly_Report_DRAFT.pdf';
    } else if (fixtureType === 'confidential') {
      buffer = await generateConfidentialPdfFixture();
      filename = 'Patent_Agreement_CONFIDENTIAL.pdf';
    } else if (fixtureType === 'clean') {
      buffer = await generateCleanPdfFixture();
      filename = 'Technical_Spec_Clean.pdf';
    } else if (fixtureType === 'image') {
      buffer = await generateSampleImageFixture();
      filename = 'Architectural_Blueprint_Sample.png';
      mimeType = 'image/png';
    } else {
      res.status(400).json({ error: { code: 'INVALID_FIXTURE', message: 'Unknown sample type.' } });
      return;
    }

    const documentRecord = await ingestDocument(sessionId, filename, buffer);
    db.saveDocument(documentRecord);

    res.status(201).json({ document: documentRecord, sessionId });
  } catch (err: any) {
    console.error('[Fixture Error]:', err);
    res.status(500).json({ error: { code: 'FIXTURE_GENERATION_FAILED', message: 'Could not generate the sample document.' } });
  }
});

/**
 * Terminal API error handler (Express arity-4 middleware).
 * Converts Multer aborts (e.g. oversized uploads rejected before any route code
 * runs) into honest JSON errors instead of a default HTML error page.
 */
apiRouter.use((err: any, req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File exceeds the maximum size of ${Math.round(CONFIG.MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB.`,
        },
      });
      return;
    }
    res.status(400).json({
      error: { code: 'UPLOAD_FAILED', message: 'Upload was rejected before it could be processed.' },
    });
    return;
  }
  console.error('[Unhandled API Error]:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
});
