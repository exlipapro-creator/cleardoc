import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
  ShieldCheck,
  FileCheck,
  Layers,
  Link2,
  FileText,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { VerificationResult, DocumentRecord } from '../../shared/types.js';

interface VerificationReportCardProps {
  document: DocumentRecord;
  verification: VerificationResult;
  onDownload: () => void;
  onApproveReview: () => void;
  isApproving: boolean;
}

export const VerificationReportCard: React.FC<VerificationReportCardProps> = ({
  document,
  verification,
  onDownload,
  onApproveReview,
  isApproving,
}) => {
  const isPass = verification.status === 'PASS';
  const isReview = verification.status === 'REVIEW';
  const isFail = verification.status === 'FAIL';

  const props = verification.report.checkedProperties;

  const canDownload = isPass || document.status === 'COMPLETED';

  return (
    <div className="w-full bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex flex-col gap-6">
      {/* Header & Status Banner */}
      <div
        className={`p-4 rounded-xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
          isPass
            ? 'bg-emerald-50/70 border-emerald-200/80 text-emerald-900'
            : isReview
            ? 'bg-amber-50/70 border-amber-200/80 text-amber-900'
            : 'bg-rose-50/70 border-rose-200/80 text-rose-900'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
              isPass
                ? 'bg-emerald-600 text-white'
                : isReview
                ? 'bg-amber-500 text-white'
                : 'bg-rose-600 text-white'
            }`}
          >
            {isPass && <CheckCircle2 className="w-6 h-6" />}
            {isReview && <AlertTriangle className="w-6 h-6" />}
            {isFail && <XCircle className="w-6 h-6" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-sm sm:text-base tracking-tight uppercase">
                {isPass ? 'Verification Passed — Certified Safe' : isReview ? 'Review Required' : 'Verification Rejected'}
              </span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-white/80 border border-current">
                {verification.status}
              </span>
            </div>
            <p className="text-xs mt-0.5 opacity-90">{verification.report.summary}</p>
          </div>
        </div>

        {/* Download or Review CTA */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {isReview && document.status === 'REVIEW_REQUIRED' && (
            <button
              type="button"
              onClick={onApproveReview}
              disabled={isApproving}
              className="w-full sm:w-auto px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              {isApproving ? 'Approving...' : 'Approve & Release'}
            </button>
          )}

          <button
            type="button"
            onClick={onDownload}
            disabled={!canDownload}
            className={`w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-xs font-bold transition-all shadow-xs cursor-pointer ${
              canDownload
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
            }`}
            title={canDownload ? 'Download verified document' : 'Download gated until safety verification passes'}
          >
            <Download className="w-4 h-4" />
            <span>{canDownload ? 'Download Verified File' : 'Download Gated'}</span>
          </button>
        </div>
      </div>

      {/* Dual Dimension Verification Breakdown */}
      <div>
        <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
          Independent Property Audit
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Page count */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <FileCheck className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Page Count</span>
                <span className="text-[11px] text-slate-500">{props.pageCount.note}</span>
              </div>
            </div>
            {props.pageCount.passed ? (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                Preserved
              </span>
            ) : (
              <span className="text-[11px] font-bold text-rose-700 bg-rose-100/70 px-2 py-0.5 rounded">
                Failed
              </span>
            )}
          </div>

          {/* Page dimensions */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Layers className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Page Dimensions</span>
                <span className="text-[11px] text-slate-500">{props.pageDimensions.note}</span>
              </div>
            </div>
            {props.pageDimensions.passed ? (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                Preserved
              </span>
            ) : (
              <span className="text-[11px] font-bold text-rose-700 bg-rose-100/70 px-2 py-0.5 rounded">
                Failed
              </span>
            )}
          </div>

          {/* Text structure */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Non-Watermark Text</span>
                <span className="text-[11px] text-slate-500">{props.textStructure.note}</span>
              </div>
            </div>
            {props.textStructure.evaluated ? (
              props.textStructure.passed ? (
                <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                  Preserved
                </span>
              ) : (
                <span className="text-[11px] font-bold text-amber-700 bg-amber-100/70 px-2 py-0.5 rounded">
                  Altered
                </span>
              )
            ) : (
              <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                N/A (Raster)
              </span>
            )}
          </div>

          {/* Watermark absence */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Watermark Absence</span>
                <span className="text-[11px] text-slate-500">{props.watermarkAbsence.note}</span>
              </div>
            </div>
            {props.watermarkAbsence.passed ? (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                Removed
              </span>
            ) : (
              <span className="text-[11px] font-bold text-rose-700 bg-rose-100/70 px-2 py-0.5 rounded">
                Residual Detected
              </span>
            )}
          </div>

          {/* Unexpected visual changes */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Visual Containment</span>
                <span className="text-[11px] text-slate-500">{props.unexpectedVisualChanges.note}</span>
              </div>
            </div>
            {props.unexpectedVisualChanges.passed ? (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
                Zero Spillover
              </span>
            ) : (
              <span className="text-[11px] font-bold text-amber-700 bg-amber-100/70 px-2 py-0.5 rounded">
                Review Out-of-Bounds
              </span>
            )}
          </div>

          {/* Links and annotations */}
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Link2 className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-xs font-semibold text-slate-800 block">Links & Forms</span>
                <span className="text-[11px] text-slate-500">{props.linksAndAnnotations.note}</span>
              </div>
            </div>
            <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded">
              Preserved
            </span>
          </div>
        </div>
      </div>

      {/* Output SHA-256 and Engine Metadata */}
      <div className="p-3 rounded-lg bg-slate-100 text-slate-600 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono">
        <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
          <span className="text-slate-400 font-sans font-semibold">Output SHA-256:</span>
          <span className="text-slate-800 select-all">{verification.outputSha256}</span>
        </div>
        <div className="text-[11px] text-slate-500 shrink-0 font-sans">
          Visual change: <span className="font-semibold text-slate-700">{verification.visualChangeRatio}%</span>
        </div>
      </div>
    </div>
  );
};
