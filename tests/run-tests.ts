/**
 * ClearDoc Verification & Regression Test Suite
 * Validates storage, magic bytes, PDF inspection, multi-signal detection,
 * surgical native removal, independent verification, and honest failure paths.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { storageService } from '../server/storage.js';
import {
  generateDraftPdfFixture,
  generateConfidentialPdfFixture,
  generateCleanPdfFixture,
  generateSampleImageFixture,
} from '../server/fixtures.js';
import { inspectPdf, PdfInspectionResult } from '../server/pdfEngine/inspector.js';
import { detectPdfWatermarks } from '../server/pdfEngine/detector.js';
import { constructRemovalPlan } from '../server/pdfEngine/planner.js';
import { executeNativeRemoval } from '../server/pdfEngine/remover.js';
import { verifyProcessedPdf } from '../server/verificationEngine/verifier.js';
import { detectRasterWatermarks } from '../server/rasterEngine/detector.js';
import { processRasterWatermark } from '../server/rasterEngine/processor.js';
import { verifyProcessedRaster } from '../server/rasterEngine/verifier.js';
import { db } from '../server/db.js';
import { DocumentRecord, AnalysisRecord } from '../shared/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    process.stdout.write(`Testing: ${name}... `);
    await fn();
    console.log('✅ PASS');
    passed++;
  } catch (err: any) {
    console.log(`❌ FAIL\n  Error: ${err.message}`);
    failed++;
  }
}

async function runTestSuite() {
  console.log('\n========================================');
  console.log('      CLEARDOC TEST SUITE EXECUTION     ');
  console.log('========================================\n');

  // Test 1: Magic Byte Validation
  await test('Storage magic byte validation on valid and invalid buffers', async () => {
    const validPdf = Buffer.from('%PDF-1.7\n%test');
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const corrupted = Buffer.from('NOT_A_VALID_DOCUMENT_FILE');

    assert.strictEqual(storageService.validateMagicBytes(validPdf).isValid, true);
    assert.strictEqual(storageService.validateMagicBytes(validPdf).detectedMime, 'application/pdf');

    assert.strictEqual(storageService.validateMagicBytes(validPng).isValid, true);
    assert.strictEqual(storageService.validateMagicBytes(validPng).detectedMime, 'image/png');

    assert.strictEqual(storageService.validateMagicBytes(corrupted).isValid, false);
  });

  // Test 2: PDF Inspection on Multi-Page Fixture
  await test('PDF Inspector extracts page count, dimensions, and text items', async () => {
    const draftPdf = await generateDraftPdfFixture();
    const inspection = await inspectPdf(draftPdf);

    assert.strictEqual(inspection.pageCount, 2, 'Should have exactly 2 pages');
    assert.strictEqual(inspection.dimensions.length, 2);
    assert.strictEqual(inspection.hasNativeText, true);

    const fullDocText = inspection.pages.map((p) => p.fullText).join(' ');
    assert.ok(fullDocText.includes('FINANCIAL REPORT'), 'Should include financial report text');
    assert.ok(fullDocText.includes('DRAFT'), 'Should extract DRAFT text');
  });

  // Test 3: Watermark Detection Multi-Signal Classification
  let targetCandidate: any = null;
  await test('Detector identifies diagonal DRAFT watermark across pages', async () => {
    const draftPdf = await generateDraftPdfFixture();
    const inspection = await inspectPdf(draftPdf);
    const result = await detectPdfWatermarks(inspection);

    assert.ok(result.candidates.length >= 1, 'Should detect at least 1 candidate');
    const draftCandidate = result.candidates.find((c) => c.text === 'DRAFT');
    assert.ok(draftCandidate, 'Must detect DRAFT candidate');
    assert.strictEqual(draftCandidate.type, 'DIAGONAL_TEXT');
    assert.strictEqual(draftCandidate.isRepeated, true);
    assert.strictEqual(draftCandidate.pages.length, 2, 'Must appear on both pages');
    assert.ok(draftCandidate.confidenceInternal >= 0.7, 'High confidence multi-signal detection');
    targetCandidate = draftCandidate;
  });

  // Test 4: Removal Planner
  let removalPlan: any = null;
  await test('Removal Planner produces deterministic machine-readable plan', async () => {
    assert.ok(targetCandidate, 'Target candidate must exist');
    removalPlan = constructRemovalPlan('doc_test_123', [targetCandidate]);

    assert.strictEqual(removalPlan.documentId, 'doc_test_123');
    assert.strictEqual(removalPlan.strategy, 'NATIVE_OBJECT_REMOVAL');
    assert.strictEqual(removalPlan.operations.length, 2, 'Two removal operations for 2 pages');
    assert.strictEqual(removalPlan.operations[0].operation, 'REMOVE_TEXT_OBJECT');
  });

  // Test 5: Native Surgical Removal
  let cleanedBuffer: Buffer | null = null;
  let originalBuffer: Buffer | null = null;
  await test('Native Surgical Removal preserves non-watermark text and page count', async () => {
    originalBuffer = await generateDraftPdfFixture();
    const result = await executeNativeRemoval(originalBuffer, removalPlan);

    cleanedBuffer = result.modifiedPdfBuffer;
    assert.strictEqual(result.preservedPageCount, 2);
    assert.ok(result.removedOperationsCount >= 2, 'Surgically removed target operations');

    // Inspect cleaned PDF to verify non-watermark text is intact
    const cleanInspection = await inspectPdf(cleanedBuffer);
    assert.strictEqual(cleanInspection.pageCount, 2);
    const cleanedText = cleanInspection.pages.map((p) => p.fullText).join(' ');
    assert.ok(cleanedText.includes('FINANCIAL REPORT'), 'Body text MUST be preserved');
    assert.ok(cleanedText.includes('Executive Summary'), 'Header text MUST be preserved');
    assert.ok(!cleanedText.includes('DRAFT'), 'DRAFT watermark MUST be absent');
  });

  // Test 6: Independent Verification Engine
  await test('Verification Engine classifies output as PASS with zero unexpected changes', async () => {
    assert.ok(originalBuffer && cleanedBuffer);
    const { verification } = await verifyProcessedPdf({
      jobId: 'job_test_001',
      documentId: 'doc_test_123',
      originalBuffer,
      cleanedBuffer,
      plan: removalPlan,
      targetCandidates: [targetCandidate],
    });

    assert.strictEqual(verification.status, 'PASS', 'Verification status must be PASS');
    assert.strictEqual(verification.pageCountPreserved, true);
    assert.strictEqual(verification.dimensionsPreserved, true);
    assert.strictEqual(verification.textPreserved, true);
    assert.strictEqual(verification.watermarkRemoved, true);
    assert.strictEqual(verification.residualWatermarkDetected, false);
    assert.strictEqual(verification.unexpectedChangeDetected, false);
  });

  // Test 7: Honest Evaluation on Clean Document (No False Positives)
  await test('Honest detection on clean document reports NO watermark', async () => {
    const cleanPdf = await generateCleanPdfFixture();
    const inspection = await inspectPdf(cleanPdf);
    const result = detectPdfWatermarks(inspection);

    assert.strictEqual(
      result.candidates.length,
      0,
      'Must NOT hallucinate watermark on legitimate clean document'
    );
  });

  // Test 8: Honest Raster Detection (real pixel analysis, no fabricated regions)
  let rasterCandidate: any = null;
  await test('Raster detector finds marking region on stamped image fixture', async () => {
    const imageBuffer = await generateSampleImageFixture();
    const result = await detectRasterWatermarks(imageBuffer);

    assert.ok(result.candidates.length >= 1, 'Should find the stamped marking region');
    rasterCandidate = result.candidates[0];
    assert.strictEqual(rasterCandidate.type, 'RASTER');
    assert.strictEqual(rasterCandidate.bbox.unit, 'px');

    const { width = 800, height = 600 } = { width: 800, height: 600 };
    assert.ok(rasterCandidate.bbox.x < width && rasterCandidate.bbox.y < height, 'bbox inside image');
    assert.ok(
      rasterCandidate.bbox.width > 0 && rasterCandidate.bbox.height > 0,
      'bbox has positive area'
    );
  });

  // Test 9: Raster Removal + Real Verification
  await test('Raster restoration is verified by measured pixel diff', async () => {
    assert.ok(rasterCandidate, 'Raster candidate must exist from previous test');
    const imageBuffer = await generateSampleImageFixture();

    const cleaned = await processRasterWatermark(imageBuffer, {
      bbox: rasterCandidate.bbox,
    });

    const { verification } = await verifyProcessedRaster({
      jobId: 'job_raster_test',
      documentId: 'doc_raster_test',
      originalBuffer: imageBuffer,
      cleanedBuffer: cleaned,
      targetBbox: rasterCandidate.bbox,
    });

    assert.strictEqual(verification.dimensionsPreserved, true, 'Dimensions must be preserved');
    assert.strictEqual(verification.status, 'PASS', `Expected PASS, got ${verification.status}: ${JSON.stringify(verification.report.details)}`);
    assert.strictEqual(verification.unexpectedChangeDetected, false, 'No out-of-mask changes allowed');
    assert.ok(verification.watermarkRemoved, 'Target region must be measurably modified');
  });

  // Test 10: Strict State Machine
  await test('Metadata store rejects illegal state transitions', async () => {
    const doc: DocumentRecord = {
      id: 'doc_state_test',
      sessionId: 'sess_state_test_01',
      originalFilename: 'state-test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'x'.repeat(64),
      pageCount: 1,
      dimensions: [{ width: 595, height: 842 }],
      status: 'UPLOADED',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    db.saveDocument(doc);

    // Illegal: cannot jump straight to processing
    assert.strictEqual(db.updateDocumentStatus('doc_state_test', 'PROCESSING'), null);
    assert.strictEqual(db.getDocument('doc_state_test')!.status, 'UPLOADED');

    // Illegal: terminal state is frozen
    db.updateDocumentStatus('doc_state_test', 'ANALYZING');
    db.updateDocumentStatus('doc_state_test', 'AWAITING_REVIEW');
    db.updateDocumentStatus('doc_state_test', 'PROCESSING');
    db.updateDocumentStatus('doc_state_test', 'VERIFYING');
    db.updateDocumentStatus('doc_state_test', 'COMPLETED');
    assert.strictEqual(db.updateDocumentStatus('doc_state_test', 'PROCESSING'), null);
    assert.strictEqual(db.getDocument('doc_state_test')!.status, 'COMPLETED');

    // Legal retry path after failure still works
    db.updateDocumentStatus('doc_state_test', 'EXPIRED');
    assert.strictEqual(db.getDocument('doc_state_test')!.status, 'EXPIRED');
  });

  // Test 11: Vocabulary word-boundary matching (no false positive on "COPYRIGHT")
  await test('Detector does not treat "COPYRIGHT" as a COPY watermark term', async () => {
    const mkItem = (text: string, page: number, fontSize: number) => ({
      page,
      text,
      fontName: 'Helvetica',
      fontSize,
      rotation: 0,
      bbox: { x: 50, y: 700, width: 300, height: fontSize },
      matrix: [1, 0, 0, 1, 50, 700],
      baselineOrigin: { x: 50, y: 700 },
    });

    const inspection: PdfInspectionResult = {
      pageCount: 2,
      sha256: 'fake',
      dimensions: [
        { width: 595, height: 842 },
        { width: 595, height: 842 },
      ],
      pages: [
        {
          pageNumber: 1,
          width: 595,
          height: 842,
          rotation: 0,
          textItems: [mkItem('COPYRIGHT ACME CORP 2024', 1, 12)],
          annotationsCount: 0,
          linksCount: 0,
          imagesCount: 0,
          fullText: 'COPYRIGHT ACME CORP 2024',
        },
        {
          pageNumber: 2,
          width: 595,
          height: 842,
          rotation: 0,
          textItems: [mkItem('COPYRIGHT ACME CORP 2024', 2, 12)],
          annotationsCount: 0,
          linksCount: 0,
          imagesCount: 0,
          fullText: 'COPYRIGHT ACME CORP 2024',
        },
      ],
      metadata: {},
      hasFormFields: false,
      hasLinks: false,
      hasAnnotations: false,
      hasNativeText: true,
    };

    const result = detectPdfWatermarks(inspection);
    assert.strictEqual(
      result.candidates.length,
      0,
      'Repeated copyright notice must NOT be flagged as a watermark'
    );
  });

  // Test 12: Privacy / garbage collection — forced expiry purges every artifact
  await test('Expired sessions are purged from disk and metadata, idempotently', async () => {
    const sessionId = `sess_gc_test_${Date.now()}`;
    const imageBuffer = await generateSampleImageFixture();

    const doc = await (async () => {
      const stored = await storageService.storeUpload(sessionId, 'gc-test.png', imageBuffer);
      return {
        id: stored.fileId,
        sessionId,
        originalFilename: 'gc-test.png',
        mimeType: 'image/png',
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        pageCount: 1,
        dimensions: [{ width: 800, height: 600 }],
        status: 'UPLOADED' as const,
        createdAt: new Date().toISOString(),
        // Already expired: retention window has fully elapsed
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
    })();
    db.saveDocument(doc);

    const paths = storageService.getSessionPaths(sessionId);
    assert.ok(fs.existsSync(paths.originalDir), 'precondition: original file stored on disk');
    assert.ok(db.getDocument(doc.id, sessionId), 'precondition: metadata present');

    // First cycle: must remove the expired record and its storage session
    await storageService.cleanupExpiredSessions(0);
    db.cleanupExpired();

    assert.strictEqual(db.getDocument(doc.id, sessionId), null, 'metadata purged');
    assert.strictEqual(fs.existsSync(paths.sessionDir), false, 'originals/outputs/previews purged from disk');

    // Idempotency: a second full cycle must be safe and clean nothing further
    await storageService.cleanupExpiredSessions(0);
    const secondPass = db.cleanupExpired();
    assert.strictEqual(secondPass, 0, 'second GC pass removes nothing new and does not throw');
    assert.strictEqual(fs.existsSync(paths.sessionDir), false);
  });

  await test('SQLite backend: cross-instance semantics (visibility, CAS race, cleanup)', async () => {
    const { SqliteBackend } = await import('../server/persist.js');
    const os = await import('os');
    const dbPath = path.join(os.tmpdir(), `cleardoc-test-${Date.now()}-${process.pid}.db`);
    let A: any = null;
    let B: any = null;
    try {
      A = new SqliteBackend(dbPath); // "instance A"
      B = new SqliteBackend(dbPath); // "instance B", same shared DB

      const mk = (id: string): DocumentRecord => ({
        id,
        sessionId: 'sqlite_sess_01',
        originalFilename: 't.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        sha256: 'x',
        pageCount: 1,
        dimensions: [{ width: 595, height: 842 }],
        status: 'UPLOADED',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      // Instance A saves; instance B must see it immediately.
      A.saveDocument(mk('docX'));
      assert.ok(B.getDocument('docX', 'sqlite_sess_01'), 'cross-instance visibility');

      // Advance to AWAITING_REVIEW so the next step is the real processing claim.
      A.updateDocumentStatus('docX', 'ANALYZING');
      A.updateDocumentStatus('docX', 'AWAITING_REVIEW');
      assert.strictEqual(B.getDocument('docX')?.status, 'AWAITING_REVIEW', 'transitions visible cross-instance');

      // Cross-instance CAS race: both instances observed AWAITING_REVIEW and
      // both try to claim PROCESSING via the atomic claim primitive.
      // Exactly one CAS may win.
      const aWon = A.claimDocument('docX', 'AWAITING_REVIEW', 'PROCESSING') !== null;
      const bWon = B.claimDocument('docX', 'AWAITING_REVIEW', 'PROCESSING') !== null;
      assert.ok(aWon !== bWon, `exactly one instance wins the race (a=${aWon} b=${bWon})`);

      // Illegal transition still rejected in shared mode.
      assert.strictEqual(
        B.updateDocumentStatus('docX', 'COMPLETED'),
        null,
        'illegal transition rejected across instances'
      );

      // Retry from failed state is legal and visible to the other instance.
      assert.ok(B.updateDocumentStatus('docX', 'PROCESSING_FAILED') !== null);
      assert.ok(A.updateDocumentStatus('docX', 'PROCESSING') !== null, 'retry visible cross-instance');

      // Analyses: replace-on-save, visible cross-instance.
      const analysis: AnalysisRecord = {
        id: 'analysisX',
        documentId: 'docX',
        engineVersion: 't',
        analysisHash: 'h',
        candidates: [],
        pageCount: 1,
        hasNativeContent: true,
        isRasterOnly: false,
        summary: '',
        createdAt: new Date().toISOString(),
      };
      A.saveAnalysis(analysis);
      assert.ok(B.getAnalysisByDocumentId('docX'), 'analysis visible cross-instance');
      A.saveAnalysis({ ...analysis, id: 'analysisX2' });
      assert.strictEqual(B.getAnalysisByDocumentId('docX')?.id, 'analysisX2', 'analysis replaced, single row');

      // Jobs + verifications cross-instance.
      A.saveJob({ id: 'jobX', documentId: 'docX', strategy: 'NATIVE_OBJECT_REMOVAL', engineVersion: 't', status: 'RUNNING', step: 'S', progressPercentage: 1, startedAt: new Date().toISOString() });
      assert.ok(B.getJob('jobX', 'sqlite_sess_01'), 'job session-scoped cross-instance');
      assert.strictEqual(B.getJob('jobX', 'other_session_xx'), null, 'foreign session job = null');

      // Expiry cleanup works on shared data and is idempotent.
      const expired = { ...mk('docY'), expiresAt: new Date(Date.now() - 1000).toISOString() };
      B.saveDocument(expired);
      assert.ok(A.cleanupExpired() >= 1, 'expired doc purged via shared DB');
      assert.strictEqual(A.getDocument('docY'), null);
      A.cleanupExpired(); // idempotent second pass

    } finally {
      // Release DB handles BEFORE removing files (Windows locks open files).
      // Lives in finally so assertion failures surface instead of masking as EBUSY.
      A.close?.();
      B.close?.();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(dbPath + suffix, { force: true });
      }
    }
  });

  if (failed > 0) {
    process.exit(1);
  }
}
runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
