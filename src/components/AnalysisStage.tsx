import React from 'react';
import { CheckCircle2, Loader2, Sparkles, AlertTriangle, Layers, Type, FileSearch } from 'lucide-react';
import { DocumentRecord, AnalysisRecord } from '../../shared/types.js';

interface AnalysisStageProps {
  document: DocumentRecord;
  analysis: AnalysisRecord | null;
  onProceedToReview: () => void;
}

export const AnalysisStage: React.FC<AnalysisStageProps> = ({
  document,
  analysis,
  onProceedToReview,
}) => {
  const isAnalyzing = !analysis;

  return (
    <div className="w-full max-w-3xl mx-auto bg-white border border-slate-200 rounded-xl shadow-xs p-6 sm:p-8">
      {/* File summary banner */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-5 mb-6">
        <div>
          <h2 className="text-base font-bold text-slate-900">{document.originalFilename}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {document.pageCount} page{document.pageCount > 1 ? 's' : ''} • {(document.sizeBytes / 1024).toFixed(1)} KB • SHA-256: {document.sha256.slice(0, 12)}...
          </p>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded bg-slate-100 text-slate-700">
          {document.mimeType.split('/')[1]?.toUpperCase()}
        </span>
      </div>

      {/* Measurable Progress Steps */}
      <div className="space-y-4 mb-8">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-slate-800">File Ingestion & Magic-Byte Validation</p>
            <p className="text-xs text-slate-500">
              Verified cryptographic signature, confirmed MIME type, and safe temporary sandbox isolation.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-slate-800">Document Structure & Geometry Inspection</p>
            <p className="text-xs text-slate-500">
              Audited {document.pageCount} page{document.pageCount > 1 ? 's' : ''}, extracted content stream operators, font dictionaries, and coordinates.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          {isAnalyzing ? (
            <Loader2 className="w-5 h-5 text-indigo-600 animate-spin shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-800">
              {isAnalyzing ? 'Detecting Watermark Elements...' : 'Multi-Signal Watermark Analysis Complete'}
            </p>
            <p className="text-xs text-slate-500">
              {isAnalyzing
                ? 'Evaluating cross-page repetition, diagonal rotation angles, font scale, and geometry.'
                : analysis?.summary || 'Analysis complete.'}
            </p>
          </div>
        </div>
      </div>

      {/* Analysis Result Summary Box */}
      {analysis && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 sm:p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" /> Detection Findings
            </span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">
              {analysis.candidates.length} Candidate{analysis.candidates.length !== 1 ? 's' : ''} Identified
            </span>
          </div>

          {analysis.candidates.length > 0 ? (
            <div className="space-y-2">
              {analysis.candidates.map((cand) => (
                <div
                  key={cand.id}
                  className="bg-white border border-slate-200/80 rounded-md p-3 flex items-center justify-between"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-800">{cand.label}</span>
                      <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-mono">
                        {cand.representation}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500">{cand.explanation}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded">
                      {cand.recommendedStrategy.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                No prominent watermark was automatically detected. You can review the document and draw a manual selection box around any region you wish to remove.
              </span>
            </div>
          )}
        </div>
      )}

      {/* CTA Button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onProceedToReview}
          disabled={isAnalyzing}
          className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-xs transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2"
        >
          <span>Proceed to Review & Selection</span>
          <CheckCircle2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
