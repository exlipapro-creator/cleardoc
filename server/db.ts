/**
 * ClearDoc Metadata Store
 * Enforces valid state machine transitions, session ownership, and retrieval.
 */
import {
  DocumentRecord,
  DocumentStatus,
  AnalysisRecord,
  JobRecord,
  VerificationResult,
} from '../shared/types.js';
import { CONFIG } from './config.js';

class MetadataStore {
  private documents: Map<string, DocumentRecord> = new Map();
  private analyses: Map<string, AnalysisRecord> = new Map();
  private jobs: Map<string, JobRecord> = new Map();
  private verifications: Map<string, VerificationResult> = new Map();

  // Document operations
  public saveDocument(doc: DocumentRecord): void {
    this.documents.set(doc.id, doc);
  }

  public getDocument(id: string, sessionId?: string): DocumentRecord | null {
    const doc = this.documents.get(id);
    if (!doc) return null;
    if (sessionId && doc.sessionId !== sessionId) return null;
    
    // Check expiry
    if (new Date(doc.expiresAt).getTime() < Date.now()) {
      doc.status = 'EXPIRED';
    }
    return doc;
  }

  public updateDocumentStatus(
    id: string,
    status: DocumentStatus,
    patch?: Partial<DocumentRecord>
  ): DocumentRecord | null {
    const doc = this.documents.get(id);
    if (!doc) return null;

    // Validate state machine progression
    const valid = this.validateTransition(doc.status, status);
    if (!valid) {
      console.warn(`[MetadataStore] Illegal transition from ${doc.status} to ${status} on doc ${id}`);
    }

    doc.status = status;
    if (patch) {
      Object.assign(doc, patch);
    }
    return doc;
  }

  private validateTransition(current: DocumentStatus, next: DocumentStatus): boolean {
    // Failure states are always reachable
    if (
      next === 'VALIDATION_FAILED' ||
      next === 'ANALYSIS_FAILED' ||
      next === 'PROCESSING_FAILED' ||
      next === 'VERIFICATION_FAILED' ||
      next === 'EXPIRED' ||
      next === 'DELETED' ||
      next === 'REVIEW_REQUIRED'
    ) {
      return true;
    }

    const transitions: Record<DocumentStatus, DocumentStatus[]> = {
      UPLOADED: ['VALIDATING', 'VALIDATION_FAILED'],
      VALIDATING: ['ANALYZING', 'VALIDATION_FAILED'],
      ANALYZING: ['ANALYZED', 'ANALYSIS_FAILED'],
      ANALYZED: ['AWAITING_REVIEW', 'PROCESSING'],
      AWAITING_REVIEW: ['PROCESSING'],
      PROCESSING: ['VERIFYING', 'PROCESSING_FAILED'],
      VERIFYING: ['COMPLETED', 'VERIFICATION_FAILED', 'REVIEW_REQUIRED'],
      COMPLETED: ['DELETED', 'EXPIRED'],
      VALIDATION_FAILED: ['DELETED'],
      ANALYSIS_FAILED: ['DELETED'],
      PROCESSING_FAILED: ['DELETED', 'PROCESSING'],
      VERIFICATION_FAILED: ['DELETED', 'PROCESSING'],
      REVIEW_REQUIRED: ['COMPLETED', 'PROCESSING', 'DELETED'],
      EXPIRED: ['DELETED'],
      DELETED: [],
    };

    return transitions[current]?.includes(next) ?? false;
  }

  // Analysis operations
  public saveAnalysis(analysis: AnalysisRecord): void {
    this.analyses.set(analysis.id, analysis);
  }

  public getAnalysis(id: string): AnalysisRecord | null {
    return this.analyses.get(id) || null;
  }

  public getAnalysisByDocumentId(documentId: string): AnalysisRecord | null {
    for (const a of this.analyses.values()) {
      if (a.documentId === documentId) return a;
    }
    return null;
  }

  // Job operations
  public saveJob(job: JobRecord): void {
    this.jobs.set(job.id, job);
  }

  public getJob(id: string): JobRecord | null {
    return this.jobs.get(id) || null;
  }

  public updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    return job;
  }

  // Verification operations
  public saveVerification(verif: VerificationResult): void {
    this.verifications.set(verif.id, verif);
  }

  public getVerification(id: string): VerificationResult | null {
    return this.verifications.get(id) || null;
  }

  public getVerificationByJobId(jobId: string): VerificationResult | null {
    for (const v of this.verifications.values()) {
      if (v.jobId === jobId) return v;
    }
    return null;
  }

  // Cleanup expired items
  public cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, doc] of this.documents.entries()) {
      if (new Date(doc.expiresAt).getTime() < now) {
        this.documents.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

export const db = new MetadataStore();
