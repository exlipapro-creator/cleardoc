/**
 * ClearDoc Metadata Persistence Backends
 *
 * Two interchangeable backends implement the same synchronous API used by the
 * route layer:
 *
 *  - MemoryBackend: per-process Maps (V1 default, zero dependencies).
 *  - SqliteBackend: a single SQLite database (node:sqlite, WAL mode) as the
 *    shared source of truth for V2 multi-instance deployments. Every read hits
 *    the database, so an instance immediately sees writes from its peers.
 *
 * The document state machine is enforced identically in both backends. The
 * SQLite backend additionally enforces it with a compare-and-set UPDATE
 * (WHERE id = ? AND status = ?), so when two instances race to claim the same
 * document (e.g. a double-clicked Process behind a load balancer), exactly one
 * wins and the loser observes the CAS miss and reports 409 — no corrupted
 * state, no double processing.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  DocumentRecord,
  DocumentStatus,
  AnalysisRecord,
  JobRecord,
  VerificationResult,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// Shared state machine (single source of truth for both backends)
// ---------------------------------------------------------------------------

export function validateTransition(current: DocumentStatus, next: DocumentStatus): boolean {
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

/** Applies a partial patch the same way the original in-memory store did. */
function applyPatch<T>(record: T, patch?: Partial<T>): T {
  if (patch) {
    return { ...record, ...patch };
  }
  return record;
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface MetadataBackend {
  saveDocument(doc: DocumentRecord): void;
  getDocument(id: string, sessionId?: string): DocumentRecord | null;
  updateDocumentStatus(
    id: string,
    status: DocumentStatus,
    patch?: Partial<DocumentRecord>
  ): DocumentRecord | null;
  /**
   * Atomic claim: transition id from `fromStatus` (the status THIS caller
   * observed) to `toStatus`. Returns the updated record, or null when the
   * document does not exist, the transition is illegal, or another actor
   * already changed the status (claim lost). This is the concurrency-safe
   * primitive for cross-instance double-processing protection.
   */
  claimDocument(
    id: string,
    fromStatus: DocumentStatus,
    toStatus: DocumentStatus,
    patch?: Partial<DocumentRecord>
  ): DocumentRecord | null;

  saveAnalysis(analysis: AnalysisRecord): void;
  getAnalysis(id: string): AnalysisRecord | null;
  getAnalysisByDocumentId(documentId: string): AnalysisRecord | null;

  saveJob(job: JobRecord): void;
  getJob(id: string, sessionId?: string): JobRecord | null;
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null;

  saveVerification(verif: VerificationResult): void;
  getVerification(id: string): VerificationResult | null;
  getVerificationByJobId(jobId: string): VerificationResult | null;

  cleanupExpired(): number;
  /** Release backend resources (no-op for memory). */
  close?(): void;
  /** Backend name for logs/health reporting. */
  readonly kind: 'memory' | 'sqlite';
}

// ---------------------------------------------------------------------------
// MemoryBackend — V1 default (per-process Maps)
// ---------------------------------------------------------------------------

export class MemoryBackend implements MetadataBackend {
  readonly kind = 'memory' as const;

  private documents: Map<string, DocumentRecord> = new Map();
  private analyses: Map<string, AnalysisRecord> = new Map();
  private jobs: Map<string, JobRecord> = new Map();
  private verifications: Map<string, VerificationResult> = new Map();

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
    if (doc.status !== status && !validateTransition(doc.status, status)) {
      console.warn(
        `[MetadataStore] Rejected illegal transition from ${doc.status} to ${status} on doc ${id}`
      );
      return null;
    }

    doc.status = status;
    if (patch) {
      Object.assign(doc, patch);
    }
    return doc;
  }

  public claimDocument(
    id: string,
    fromStatus: DocumentStatus,
    toStatus: DocumentStatus,
    patch?: Partial<DocumentRecord>
  ): DocumentRecord | null {
    const doc = this.documents.get(id);
    if (!doc) return null;
    if (doc.status !== fromStatus) return null; // someone else got there first
    return this.updateDocumentStatus(id, toStatus, patch);
  }

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

// ---------------------------------------------------------------------------
// SqliteBackend — V2 shared source of truth (node:sqlite, WAL)
// ---------------------------------------------------------------------------

export class SqliteBackend implements MetadataBackend {
  readonly kind = 'sqlite' as const;

  private db: DatabaseSync;
  private stmtGetDoc: StatementSync;
  private stmtGetDocSession: StatementSync;
  private stmtInsertDoc: StatementSync;
  private stmtCasStatus: StatementSync;
  private stmtPatchDoc: StatementSync;

  private stmtGetAnalysis: StatementSync;
  private stmtGetAnalysisByDoc: StatementSync;
  private stmtDeleteAnalysisByDoc: StatementSync;
  private stmtInsertAnalysis: StatementSync;

  private stmtGetJob: StatementSync;
  private stmtUpsertJob: StatementSync;

  private stmtGetVerif: StatementSync;
  private stmtGetVerifByJob: StatementSync;
  private stmtUpsertVerif: StatementSync;

  private stmtDeleteExpiredAnalyses: StatementSync;
  private stmtDeleteExpiredJobs: StatementSync;
  private stmtDeleteOrphanVerifs: StatementSync;
  private stmtDeleteExpiredDocs: StatementSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL allows concurrent readers with one writer; busy_timeout makes the
    // rare write contention between instances wait instead of failing.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        document_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_document ON jobs(document_id);
      CREATE INDEX IF NOT EXISTS idx_verifs_job ON verifications(job_id);
    `);

    this.stmtGetDoc = this.db.prepare('SELECT payload FROM documents WHERE id = ?');
    this.stmtGetDocSession = this.db.prepare('SELECT session_id FROM documents WHERE id = ?');
    this.stmtInsertDoc = this.db.prepare(
      `INSERT INTO documents (id, session_id, status, expires_at_ms, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id,
         status = excluded.status, expires_at_ms = excluded.expires_at_ms,
         payload = excluded.payload`
    );
    // Compare-and-set: the UPDATE only lands when the status still matches what
    // this instance observed. A second concurrent claim changes 0 rows.
    this.stmtCasStatus = this.db.prepare(
      `UPDATE documents SET status = ?, payload = ? WHERE id = ? AND status = ?`
    );
    this.stmtPatchDoc = this.db.prepare('UPDATE documents SET payload = ? WHERE id = ?');

    this.stmtGetAnalysis = this.db.prepare('SELECT payload FROM analyses WHERE document_id = ?');
    this.stmtGetAnalysisByDoc = this.stmtGetAnalysis;
    this.stmtDeleteAnalysisByDoc = this.db.prepare('DELETE FROM analyses WHERE document_id = ?');
    this.stmtInsertAnalysis = this.db.prepare(
      'INSERT INTO analyses (document_id, payload) VALUES (?, ?)'
    );

    this.stmtGetJob = this.db.prepare('SELECT payload FROM jobs WHERE id = ?');
    this.stmtUpsertJob = this.db.prepare(
      `INSERT INTO jobs (id, document_id, payload) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
    );

    this.stmtGetVerif = this.db.prepare('SELECT payload FROM verifications WHERE id = ?');
    this.stmtGetVerifByJob = this.db.prepare(
      'SELECT payload FROM verifications WHERE job_id = ? LIMIT 1'
    );
    this.stmtUpsertVerif = this.db.prepare(
      `INSERT INTO verifications (id, job_id, payload) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
    );

    this.stmtDeleteExpiredAnalyses = this.db.prepare(
      'DELETE FROM analyses WHERE document_id IN (SELECT id FROM documents WHERE expires_at_ms < ?)'
    );
    this.stmtDeleteExpiredJobs = this.db.prepare(
      'DELETE FROM jobs WHERE document_id IN (SELECT id FROM documents WHERE expires_at_ms < ?)'
    );
    this.stmtDeleteOrphanVerifs = this.db.prepare(
      'DELETE FROM verifications WHERE job_id NOT IN (SELECT id FROM jobs)'
    );
    this.stmtDeleteExpiredDocs = this.db.prepare(
      'DELETE FROM documents WHERE expires_at_ms < ?'
    );
  }

  private readDoc(id: string): DocumentRecord | null {
    const row = this.stmtGetDoc.get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as DocumentRecord) : null;
  }

  public saveDocument(doc: DocumentRecord): void {
    this.stmtInsertDoc.run(
      doc.id,
      doc.sessionId,
      doc.status,
      new Date(doc.expiresAt).getTime(),
      JSON.stringify(doc)
    );
  }

  public getDocument(id: string, sessionId?: string): DocumentRecord | null {
    if (sessionId) {
      const owner = this.stmtGetDocSession.get(id) as { session_id: string } | undefined;
      if (!owner || owner.session_id !== sessionId) return null;
    }
    const doc = this.readDoc(id);
    if (!doc) return null;

    // Check expiry (view-level, matching the memory backend semantics)
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
    const current = this.readDoc(id);
    if (!current) return null;

    if (current.status === status) {
      // Same-status patch (no transition): plain update.
      const updated = applyPatch(current, patch);
      this.stmtPatchDoc.run(JSON.stringify(updated), id);
      return updated;
    }

    if (!validateTransition(current.status, status)) {
      console.warn(
        `[MetadataStore] Rejected illegal transition from ${current.status} to ${status} on doc ${id}`
      );
      return null;
    }

    // CAS: only the instance that observed the pre-transition status wins.
    const updated = applyPatch({ ...current, status }, patch);
    const res = this.stmtCasStatus.run(status, JSON.stringify(updated), id, current.status);
    if (res.changes === 0) {
      console.warn(
        `[MetadataStore] CAS lost on doc ${id} (${current.status} -> ${status}); another instance claimed it`
      );
      return null;
    }
    return updated;
  }

  public claimDocument(
    id: string,
    fromStatus: DocumentStatus,
    toStatus: DocumentStatus,
    patch?: Partial<DocumentRecord>
  ): DocumentRecord | null {
    if (!validateTransition(fromStatus, toStatus)) {
      console.warn(
        `[MetadataStore] Rejected illegal transition from ${fromStatus} to ${toStatus} on doc ${id}`
      );
      return null;
    }
    const current = this.readDoc(id);
    if (!current) return null;
    const updated = applyPatch({ ...current, status: toStatus }, patch);
    // True CAS against the CALLER's observed status — not a fresh read — so a
    // peer instance that claimed the document in between causes 0 changed rows.
    const res = this.stmtCasStatus.run(toStatus, JSON.stringify(updated), id, fromStatus);
    if (res.changes === 0) {
      console.warn(
        `[MetadataStore] Claim lost on doc ${id} (${fromStatus} -> ${toStatus}); another instance claimed it`
      );
      return null;
    }
    return updated;
  }

  public saveAnalysis(analysis: AnalysisRecord): void {
    // One authoritative analysis per document (replace any previous).
    this.stmtDeleteAnalysisByDoc.run(analysis.documentId);
    this.stmtInsertAnalysis.run(analysis.documentId, JSON.stringify(analysis));
  }

  public getAnalysis(id: string): AnalysisRecord | null {
    const row = this.stmtGetAnalysis.get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AnalysisRecord) : null;
  }

  public getAnalysisByDocumentId(documentId: string): AnalysisRecord | null {
    const row = this.stmtGetAnalysisByDoc.get(documentId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AnalysisRecord) : null;
  }

  public saveJob(job: JobRecord): void {
    this.stmtUpsertJob.run(job.id, job.documentId, JSON.stringify(job));
  }

  public getJob(id: string, sessionId?: string): JobRecord | null {
    const row = this.stmtGetJob.get(id) as { payload: string } | undefined;
    if (!row) return null;
    const job = JSON.parse(row.payload) as JobRecord;
    if (sessionId) {
      // Jobs are scoped to the owning document's session
      const owner = this.stmtGetDocSession.get(job.documentId) as
        | { session_id: string }
        | undefined;
      if (!owner || owner.session_id !== sessionId) return null;
    }
    return job;
  }

  public updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const job = this.getJob(id);
    if (!job) return null;
    const updated = applyPatch(job, patch);
    this.stmtUpsertJob.run(id, updated.documentId, JSON.stringify(updated));
    return updated;
  }

  public saveVerification(verif: VerificationResult): void {
    this.stmtUpsertVerif.run(verif.id, verif.jobId, JSON.stringify(verif));
  }

  public getVerification(id: string): VerificationResult | null {
    const row = this.stmtGetVerif.get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as VerificationResult) : null;
  }

  public getVerificationByJobId(jobId: string): VerificationResult | null {
    const row = this.stmtGetVerifByJob.get(jobId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as VerificationResult) : null;
  }

  public cleanupExpired(): number {
    const now = Date.now();
    this.stmtDeleteExpiredAnalyses.run(now);
    this.stmtDeleteExpiredJobs.run(now);
    this.stmtDeleteOrphanVerifs.run();
    const res = this.stmtDeleteExpiredDocs.run(now);
    return Number(res.changes);
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export function createBackend(sharedDbPath: string): MetadataBackend {
  if (sharedDbPath) {
    return new SqliteBackend(sharedDbPath);
  }
  return new MemoryBackend();
}
