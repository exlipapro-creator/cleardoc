/**
 * ClearDoc Main Application
 * State orchestration for document ingestion, analysis, review, precision removal,
 * dual-dimension verification, and gated certified download.
 */
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header.tsx';
import { UploadDropzone } from './components/UploadDropzone.tsx';
import { AnalysisStage } from './components/AnalysisStage.tsx';
import { DocumentViewer } from './components/DocumentViewer.tsx';
import { CandidateInspector } from './components/CandidateInspector.tsx';
import { ComparisonViewer } from './components/ComparisonViewer.tsx';
import { VerificationReportCard } from './components/VerificationReportCard.tsx';
import { PrivacyFooter } from './components/PrivacyFooter.tsx';
import {
  DocumentRecord,
  AnalysisRecord,
  JobRecord,
  VerificationResult,
  RemovalStrategy,
  ManualRegion,
} from '../shared/types.ts';
import { apiRequest, parseResponse, ApiError, onServiceWaking } from './api.ts';
import { Loader2, ArrowLeft, AlertCircle, WifiOff } from 'lucide-react';

export default function App() {
  const [sessionId, setSessionId] = useState<string>(() => {
    return localStorage.getItem('cleardoc_session_id') || '';
  });

  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRecord | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);

  const [activeStep, setActiveStep] = useState<
    'UPLOAD' | 'ANALYSIS' | 'REVIEW' | 'PROCESSING' | 'VERIFIED'
  >('UPLOAD');

  const [currentPage, setCurrentPage] = useState(1);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [manualRegions, setManualRegions] = useState<ManualRegion[]>([]);
  const [preferredStrategy, setPreferredStrategy] = useState<RemovalStrategy>(
    'NATIVE_OBJECT_REMOVAL'
  );

  // True while the API client is probing /health because the service is
  // genuinely unreachable (Render Free spin-down / restart). Never set by a
  // timer — only by observed unreachable reality.
  const [serviceWaking, setServiceWaking] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const announce = (msg: string) => {
    setLiveAnnouncement(msg);
  };

  const onApiFailure = (err: unknown, fallback: string) => {
    setErrorMessage(err instanceof Error ? err.message : fallback);
    announce(`Error: ${err instanceof Error ? err.message : fallback}`);
  };

  useEffect(() => {
    const off = onServiceWaking(() => setServiceWaking(true));
    return off;
  }, []);

  const handleFileUpload = async (file: File) => {
    try {
      setIsUploading(true);
      setUploadProgress(20);
      setErrorMessage(null);
      announce('Uploading and validating document...');

      const formData = new FormData();
      formData.append('file', file);

      const headers: Record<string, string> = {};
      if (sessionId) headers['x-session-id'] = sessionId;

      const res = await apiRequest('/api/documents', {
        method: 'POST',
        headers,
        body: formData,
      });
      const data = await parseResponse<any>(res);

      setUploadProgress(70);
      const newSessionId = res.headers.get('x-session-id') || data.sessionId;
      if (newSessionId) {
        setSessionId(newSessionId);
        localStorage.setItem('cleardoc_session_id', newSessionId);
      }

      setDocument(data.document);
      setCurrentPage(1);
      setActiveStep('ANALYSIS');
      announce('Document ingested and validated. Analyzing structure...');

      // Trigger analysis
      await triggerAnalysis(data.document.id, newSessionId);
    } catch (err: any) {
      onApiFailure(err, 'Error uploading file');
    } finally {
      setIsUploading(false);
      setUploadProgress(100);
      setServiceWaking(false);
    }
  };

  const handleLoadSample = async (type: 'draft' | 'confidential' | 'clean' | 'image') => {
    try {
      setIsUploading(true);
      setUploadProgress(30);
      setErrorMessage(null);
      announce(`Generating test fixture sample: ${type}...`);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sessionId) headers['x-session-id'] = sessionId;

      const res = await apiRequest('/api/fixtures/create-sample', {
        method: 'POST',
        headers,
        body: JSON.stringify({ fixtureType: type }),
      });
      const data = await parseResponse<any>(res);

      const newSessionId = res.headers.get('x-session-id') || data.sessionId;
      if (newSessionId) {
        setSessionId(newSessionId);
        localStorage.setItem('cleardoc_session_id', newSessionId);
      }

      setDocument(data.document);
      setCurrentPage(1);
      setActiveStep('ANALYSIS');
      announce('Test fixture loaded. Inspecting structure...');

      await triggerAnalysis(data.document.id, newSessionId);
    } catch (err: any) {
      onApiFailure(err, 'Error loading sample');
    } finally {
      setIsUploading(false);
      setUploadProgress(100);
      setServiceWaking(false);
    }
  };

  const triggerAnalysis = async (docId: string, sessId: string) => {
    try {
      setAnalysisError(null);
      const headers: Record<string, string> = {};
      if (sessId) headers['x-session-id'] = sessId;

      const res = await apiRequest(`/api/documents/${docId}/analyze`, {
        method: 'POST',
        headers,
      }, 30000);
      const data = await parseResponse<any>(res);

      setDocument(data.document);
      setAnalysis(data.analysis);

      // Pre-select detected candidates
      const detectedIds = data.analysis.candidates
        .filter((c: any) => c.selected)
        .map((c: any) => c.id);
      setSelectedCandidateIds(detectedIds);

      announce(`Analysis complete: ${data.analysis.candidates.length} candidates identified.`);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      setAnalysisError(message);
      onApiFailure(err, 'Analysis failed');
      setServiceWaking(false);
    }
  };

  const retryAnalysis = async () => {
    if (!document) return;
    setErrorMessage(null);
    announce('Retrying analysis...');
    await triggerAnalysis(document.id, sessionId);
  };

  const handleToggleCandidate = (id: string) => {
    setSelectedCandidateIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (!analysis) return;
    setSelectedCandidateIds(analysis.candidates.map((c) => c.id));
  };

  const handleDeselectAll = () => {
    setSelectedCandidateIds([]);
  };

  const handleAddManualRegion = (region: ManualRegion) => {
    setManualRegions((prev) => [...prev, region]);
    announce(`Manual selection region added to page ${region.page}`);
  };

  const handleRemoveManualRegion = (id: string) => {
    setManualRegions((prev) => prev.filter((m) => m.id !== id));
  };

  const handleExecuteProcess = async () => {
    if (!document) return;
    try {
      setIsProcessing(true);
      setActiveStep('PROCESSING');
      setErrorMessage(null);
      announce('Executing surgical removal plan and independent verification...');

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sessionId) headers['x-session-id'] = sessionId;

      const res = await apiRequest(`/api/documents/${document.id}/process`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          selectedCandidateIds,
          manualRegions,
          preferredStrategy,
        }),
      }, 180000);
      const data = await parseResponse<any>(res);

      setJob(data.job);
      setVerification(data.verification);
      setDocument(data.document);
      setActiveStep('VERIFIED');
      announce(`Processing complete. Verification status: ${data.verification.status}`);
    } catch (err: any) {
      onApiFailure(err, 'Processing failed');
      if (err instanceof ApiError && (err.code === 'SESSION_EXPIRED' || err.code === 'DOCUMENT_NOT_FOUND')) {
        setActiveStep('UPLOAD');
      } else {
        setActiveStep('REVIEW');
      }
    } finally {
      setIsProcessing(false);
      setServiceWaking(false);
    }
  };

  const handleApproveReview = async () => {
    if (!document) return;
    try {
      setIsApproving(true);
      const headers: Record<string, string> = {};
      if (sessionId) headers['x-session-id'] = sessionId;

      const res = await apiRequest(`/api/documents/${document.id}/approve-review`, {
        method: 'POST',
        headers,
      });
      const data = await parseResponse<any>(res);

      setDocument(data.document);
      announce('Document review approved. Released for download.');
    } catch (err: any) {
      onApiFailure(err, 'Approval failed');
    } finally {
      setIsApproving(false);
      setServiceWaking(false);
    }
  };

  const handleDownload = () => {
    if (!document) return;
    window.location.href = `/api/documents/${document.id}/download`;
  };

  const handleReset = () => {
    setDocument(null);
    setAnalysis(null);
    setJob(null);
    setVerification(null);
    setSelectedCandidateIds([]);
    setManualRegions([]);
    setActiveStep('UPLOAD');
    setErrorMessage(null);
    setAnalysisError(null);
    announce('Session reset to upload screen.');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Screen reader live announcements */}
      <div role="status" aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </div>

      {/* Header */}
      <Header
        onLoadSample={handleLoadSample}
        onReset={handleReset}
        hasActiveDocument={Boolean(document)}
        isLoadingSample={isUploading}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col items-center">
        {/* Cold-start / wake banner: shown only while /health probing confirms
            the service is genuinely unreachable (Render Free spin-down). */}
        {serviceWaking && (
          <div className="w-full max-w-4xl mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs sm:text-sm flex items-center gap-2">
            <WifiOff className="w-5 h-5 text-amber-600 shrink-0" />
            <span>Preparing ClearDoc… the service is waking up. Your request will continue automatically.</span>
          </div>
        )}

        {/* Error notification banner */}
        {errorMessage && (
          <div className="w-full max-w-4xl mb-6 p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs sm:text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-xs font-semibold text-rose-700 hover:text-rose-900 cursor-pointer ml-3"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* STEP 1: UPLOAD */}
        {activeStep === 'UPLOAD' && (
          <UploadDropzone
            onFileUpload={handleFileUpload}
            onLoadSample={handleLoadSample}
            isUploading={isUploading}
            uploadProgress={uploadProgress}
          />
        )}

        {/* STEP 2: ANALYSIS */}
        {activeStep === 'ANALYSIS' && document && (
          <AnalysisStage
            document={document}
            analysis={analysis}
            error={analysisError}
            onRetry={retryAnalysis}
            onProceedToReview={() => {
              setActiveStep('REVIEW');
              announce('Proceeded to review screen.');
            }}
          />
        )}

        {/* STEP 3: REVIEW & SELECTION */}
        {activeStep === 'REVIEW' && document && analysis && (
          <div className="w-full space-y-6">
            {/* Context breadcrumb & actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
              <div>
                <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">
                  Review & Removal Plan
                </span>
                <h1 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <span>{document.originalFilename}</span>
                  <span className="text-xs font-normal text-slate-500">
                    ({document.pageCount} page{document.pageCount > 1 ? 's' : ''})
                  </span>
                </h1>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveStep('ANALYSIS')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Inspection</span>
                </button>
              </div>
            </div>

            {/* Main Interactive Work Area */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-8 w-full">
                <DocumentViewer
                  document={document}
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  candidates={analysis.candidates}
                  selectedCandidateIds={selectedCandidateIds}
                  onToggleCandidate={handleToggleCandidate}
                  manualRegions={manualRegions}
                  onAddManualRegion={handleAddManualRegion}
                  onRemoveManualRegion={handleRemoveManualRegion}
                  allowManualRegions={document.mimeType !== 'application/pdf'}
                />
              </div>

              <div className="lg:col-span-4 w-full">
                <CandidateInspector
                  candidates={analysis.candidates}
                  selectedCandidateIds={selectedCandidateIds}
                  onToggleCandidate={handleToggleCandidate}
                  onSelectAll={handleSelectAll}
                  onDeselectAll={handleDeselectAll}
                  manualRegions={manualRegions}
                  showManualRegions={document.mimeType !== 'application/pdf'}
                  isRasterDocument={document.mimeType !== 'application/pdf'}
                  onExecuteProcess={handleExecuteProcess}
                  isProcessing={isProcessing}
                />
              </div>
            </div>
          </div>
        )}

        {/* STEP 4: PROCESSING WORKER STAGE */}
        {activeStep === 'PROCESSING' && (
          <div className="w-full max-w-md mx-auto my-16 bg-white border border-slate-200 rounded-xl p-8 text-center shadow-md space-y-4">
            <div className="w-14 h-14 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto animate-pulse">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Executing Precision Removal Plan...
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Surgically editing content stream operators and verifying document invariants.
              </p>
            </div>
            <div className="text-xs font-mono text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-md py-2 px-3">
              Running structural & pixelmatch diff audit
            </div>
          </div>
        )}

        {/* STEP 5: VERIFIED CERTIFICATION & COMPARISON */}
        {activeStep === 'VERIFIED' && document && verification && (
          <div className="w-full space-y-6">
            {/* Back to review action */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setActiveStep('REVIEW')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-600 cursor-pointer shadow-2xs"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Modify Selection / Re-run Plan</span>
              </button>
            </div>

            {/* Verification Report Card */}
            <VerificationReportCard
              document={document}
              verification={verification}
              onDownload={handleDownload}
              onApproveReview={handleApproveReview}
              isApproving={isApproving}
            />

            {/* Post-Process Interactive Comparison Viewer */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">
                  Visual Verification Inspection
                </h2>
                <span className="text-xs text-slate-500">
                  Inspect output before release
                </span>
              </div>

              <ComparisonViewer
                document={document}
                verification={verification}
                currentPage={currentPage}
                onPageChange={setCurrentPage}
              />
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <PrivacyFooter />
    </div>
  );
}
