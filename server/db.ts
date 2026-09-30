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

    // Enforce the state machine: illegal transitions are rejected, not just logged.
    if (doc.status !== status && !this.validateTransition(doc.status, status)) {
      console.warn(`[MetadataStore] Rejected illegal transition from ${doc.status} to ${status} on doc ${id}`);
      return null;
    }

    doc.status = status;
    if (patch) {
      Object.assign(doc, patch);
    }
    return doc;
  }

  private validateTransition(current: DocumentStatus, next: DocumentStatus): boolean {
    // Terminal/expiry transitions are always permitted from any state.
    if (next === 'EXPIRED' || next === 'DELETED') return true;

    const transitions: Record<DocumentStatus, DocumentStatus[]> = {
      UPLOADED: ['ANALYZING', 'VALIDATION_FAILED'],
      ANALYZING: ['AWAITING_REVIEW', 'ANALYSIS_FAILED'],
      AWAITING_REVIEW: ['PROCESSING'],
      PROCESSING: ['VERIFYING', 'PROCESSING_FAILED'],
      VERIFYING: ['COMPLETED', 'REVIEW_REQUIRED', 'VERIFICATION_FAILED'],
      REVIEW_REQUIRED: ['COMPLETED', 'PROCESSING'],
      PROCESSING_FAILED: ['PROCESSING'],
      VERIFICATION_FAILED: ['PROCESSING'],
      ANALYSIS_FAILED: ['ANALYZING'],
      VALIDATION_FAILED: [],
      COMPLETED: [],
      EXPIRED: [],
      DELETED: [],
    };

    return transitions[current]?.includes(next) ?? false;
  }

  // Analysis operations
  // One authoritative analysis per document: re-analysis replaces the previous record.
  public saveAnalysis(analysis: AnalysisRecord): void {
    for (const [id, existing] of this.analyses.entries()) {
      if (existing.documentId === analysis.documentId) this.analyses.delete(id);
    }
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

  public getJob(id: string, sessionId?: string): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (sessionId) {
      // Jobs are scoped to the owning document's session
      const doc = this.documents.get(job.documentId);
      if (!doc || doc.sessionId !== sessionId) return null;
    }
    return job;
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

  // Cleanup expired items and their dependent records
  public cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    const expiredDocIds = new Set<string>();
    for (const [id, doc] of this.documents.entries()) {
      if (new Date(doc.expiresAt).getTime() < now) {
        expiredDocIds.add(id);
        this.documents.delete(id);
        cleaned++;
      }
    }
    if (expiredDocIds.size === 0) return 0;

    for (const [id, analysis] of this.analyses.entries()) {
      if (expiredDocIds.has(analysis.documentId)) this.analyses.delete(id);
    }
    for (const [id, job] of this.jobs.entries()) {
      if (expiredDocIds.has(job.documentId)) this.jobs.delete(id);
    }
    for (const [id, verif] of this.verifications.entries()) {
      const job = this.jobs.get(verif.jobId);
      if (!job) this.verifications.delete(id);
    }
    return cleaned;
  }
}

export const db = new MetadataStore();
