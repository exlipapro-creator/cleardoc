/**
 * ClearDoc Shared Contracts & Type Definitions
 * Authoritative schemas for document lifecycle, candidates, removal plans, and verification
 */

export type DocumentStatus =
  | 'UPLOADED'
  | 'VALIDATING'
  | 'ANALYZING'
  | 'ANALYZED'
  | 'AWAITING_REVIEW'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'VALIDATION_FAILED'
  | 'ANALYSIS_FAILED'
  | 'PROCESSING_FAILED'
  | 'VERIFICATION_FAILED'
  | 'REVIEW_REQUIRED'
  | 'EXPIRED'
  | 'DELETED';

export type WatermarkType =
  | 'TEXT'
  | 'VECTOR'
  | 'IMAGE'
  | 'RASTER'
  | 'REPEATED_HEADER_FOOTER'
  | 'DIAGONAL_TEXT';

export type RemovalStrategy =
  | 'NATIVE_OBJECT_REMOVAL'
  | 'NATIVE_VECTOR_REMOVAL'
  | 'LOCALIZED_RASTER_RESTORATION'
  | 'PRECISION_RECONSTRUCTION';

export type CandidateRepresentation =
  | 'PDF_TEXT_OBJECT'
  | 'PDF_XOBJECT'
  | 'PDF_VECTOR_PATH'
  | 'RASTER_IMAGE_REGION';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'pt' | 'px' | 'normalized';
}

export interface WatermarkCandidate {
  id: string;
  type: WatermarkType;
  label: string;
  text?: string;
  pages: number[];
  bbox: BoundingBox;
  opacity?: number;
  rotation?: number;
  fontSize?: number;
  fontName?: string;
  color?: string;
  representation: CandidateRepresentation;
  detectionMethod: string;
  confidenceInternal: number; // 0.0 to 1.0 (used by engine, not marketing)
  recommendedStrategy: RemovalStrategy;
  explanation: string;
  isRepeated: boolean;
  selected?: boolean;
}

export interface ManualRegion {
  id: string;
  page: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface RemovalPlanOperation {
  page: number;
  targetCandidateId: string;
  operation: 'REMOVE_TEXT_OBJECT' | 'REMOVE_XOBJECT' | 'REMOVE_VECTOR_PATH' | 'RESTORE_RASTER_REGION';
  details?: Record<string, unknown>;
}

export interface RemovalPlan {
  documentId: string;
  strategy: RemovalStrategy;
  engineVersion: {
    detector: string;
    pdfEngine: string;
    restorationEngine: string;
    verificationEngine: string;
  };
  operations: RemovalPlanOperation[];
  createdAt: string;
}

export interface VerificationCheckItem {
  evaluated: boolean;
  passed: boolean;
  note: string;
}

export interface VerificationResult {
  id: string;
  jobId: string;
  documentId: string;
  pageCountPreserved: boolean;
  dimensionsPreserved: boolean;
  textPreserved: boolean;
  imagesPreserved: boolean;
  linksPreserved: boolean;
  annotationsPreserved: boolean;
  watermarkRemoved: boolean;
  residualWatermarkDetected: boolean;
  unexpectedChangeDetected: boolean;
  visualChangeRatio: number; // percentage (0.00 to 100.00%)
  status: 'PASS' | 'REVIEW' | 'FAIL';
  report: {
    summary: string;
    checkedProperties: {
      pageCount: VerificationCheckItem;
      pageDimensions: VerificationCheckItem;
      textStructure: VerificationCheckItem;
      embeddedImages: VerificationCheckItem;
      linksAndAnnotations: VerificationCheckItem;
      watermarkAbsence: VerificationCheckItem;
      unexpectedVisualChanges: VerificationCheckItem;
    };
    unexpectedRegionsCount: number;
    residualDetectionSummary: string;
    details: string[];
  };
  outputSha256: string;
  verifiedAt: string;
}

export interface DocumentRecord {
  id: string;
  sessionId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  dimensions: Array<{ width: number; height: number }>;
  status: DocumentStatus;
  errorMessage?: string;
  errorCode?: string;
  createdAt: string;
  expiresAt: string;
  analysisId?: string;
  lastJobId?: string;
  isPasswordProtected?: boolean;
}

export interface AnalysisRecord {
  id: string;
  documentId: string;
  engineVersion: string;
  analysisHash: string;
  candidates: WatermarkCandidate[];
  pageCount: number;
  hasNativeContent: boolean;
  isRasterOnly: boolean;
  summary: string;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  documentId: string;
  strategy: RemovalStrategy;
  engineVersion: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  step: string;
  progressPercentage: number;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  verificationId?: string;
  verificationStatus?: 'PASS' | 'REVIEW' | 'FAIL';
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
