import React from 'react';
import { FileCheck, RefreshCw, Lock, FlaskConical } from 'lucide-react';

interface HeaderProps {
  onLoadSample: (type: 'draft' | 'confidential' | 'clean' | 'image') => void;
  onReset: () => void;
  hasActiveDocument: boolean;
  isLoadingSample: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onLoadSample,
  onReset,
  hasActiveDocument,
  isLoadingSample,
}) => {
  return (
    <header className="border-b border-slate-200 bg-white sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo & Platform Info */}
        <div className="flex items-center gap-3 cursor-pointer" onClick={onReset}>
          <div className="w-10 h-10 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-sm ring-1 ring-indigo-500/20">
            <FileCheck className="w-6 h-6 stroke-[2.2]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg text-slate-900 tracking-tight">ClearDoc</span>
              <span className="text-[11px] font-semibold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded border border-emerald-200/60 uppercase tracking-wider">
                Native Preservation
              </span>
            </div>
            <p className="text-xs text-slate-500 hidden sm:block">
              Precision Document Watermark Removal & Preservation Engine
            </p>
          </div>
        </div>

        {/* Actions & Session Notice */}
        <div className="flex items-center gap-3">
          {/* Quick test fixtures menu */}
          {!hasActiveDocument && (
            <div className="hidden md:flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium mr-1 flex items-center gap-1">
                <FlaskConical className="w-3.5 h-3.5 text-indigo-500" aria-hidden="true" /> Samples:
              </span>
              <button
                type="button"
                onClick={() => onLoadSample('draft')}
                disabled={isLoadingSample}
                className="text-xs px-2.5 py-1.5 rounded-md font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
                title="2-page PDF with diagonal DRAFT watermark across pages"
              >
                Financial Report (DRAFT)
              </button>
              <button
                type="button"
                onClick={() => onLoadSample('confidential')}
                disabled={isLoadingSample}
                className="text-xs px-2.5 py-1.5 rounded-md font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
                title="Patent agreement with CONFIDENTIAL watermark"
              >
                Agreement (CONFIDENTIAL)
              </button>
              <button
                type="button"
                onClick={() => onLoadSample('image')}
                disabled={isLoadingSample}
                className="text-xs px-2.5 py-1.5 rounded-md font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
                title="PNG image with watermark stamp"
              >
                Blueprint (PNG)
              </button>
              <button
                type="button"
                onClick={() => onLoadSample('clean')}
                disabled={isLoadingSample}
                className="text-xs px-2.5 py-1.5 rounded-md font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
                title="Document with no watermark (verifies honest failure)"
              >
                Clean PDF
              </button>
            </div>
          )}

          {/* Privacy Session Indicator */}
          <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-md">
            <Lock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            <span className="font-medium hidden sm:inline">Secure Session</span>
            <span className="text-slate-400 hidden sm:inline">•</span>
            <span className="text-slate-500">Files auto-purged in 1h</span>
          </div>

          {/* Reset button when document is loaded */}
          {hasActiveDocument && (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 px-3 py-1.5 rounded-md shadow-2xs transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>New File</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
