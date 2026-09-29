/**
 * ClearDoc Verification & Regression Test Suite
 * Validates storage, magic bytes, PDF inspection, multi-signal detection,
 * surgical native removal, independent verification, and honest failure paths.
 */
import assert from 'assert';
import { storageService } from '../server/storage.js';
import {
  generateDraftPdfFixture,
  generateConfidentialPdfFixture,
  generateCleanPdfFixture,
} from '../server/fixtures.js';
import { inspectPdf } from '../server/pdfEngine/inspector.js';
import { detectPdfWatermarks } from '../server/pdfEngine/detector.js';
import { constructRemovalPlan } from '../server/pdfEngine/planner.js';
import { executeNativeRemoval } from '../server/pdfEngine/remover.js';
import { verifyProcessedPdf } from '../server/verificationEngine/verifier.js';

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

  console.log('\n========================================');
  console.log(`TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
