import React from 'react';
import {
  CheckSquare,
  Square,
  Eraser,
  Info,
  CheckCircle2,
  FileText,
  Image,
  MousePointerSquareDashed,
} from 'lucide-react';
import {
  WatermarkCandidate,
  ManualRegion,
} from '../../shared/types.js';

interface CandidateInspectorProps {
  candidates: WatermarkCandidate[];
  selectedCandidateIds: string[];
  onToggleCandidate: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  manualRegions: ManualRegion[];
  /** Manual region drawing is only supported for raster images. */
  showManualRegions: boolean;
  /** Raster documents are always restored via localized inpainting. */
  isRasterDocument: boolean;
  onExecuteProcess: () => void;
  isProcessing: boolean;
}

export const CandidateInspector: React.FC<CandidateInspectorProps> = ({
  candidates,
  selectedCandidateIds,
  onToggleCandidate,
  onSelectAll,
  onDeselectAll,
  manualRegions,
  showManualRegions,
  isRasterDocument,
  onExecuteProcess,
  isProcessing,
}) => {
  const totalSelected = selectedCandidateIds.length + manualRegions.length;

  return (
    <div className="w-full bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900 tracking-tight">
            Detected Watermark Elements
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Review removal targets before starting
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer"
          >
            Select All
          </button>
          <span className="text-slate-300">|</span>
          <button
            type="button"
            onClick={onDeselectAll}
            className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Candidate List */}
      <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
        {candidates.map((cand) => {
          const isSelected = selectedCandidateIds.includes(cand.id);
          return (
            <div
              key={cand.id}
              onClick={() => onToggleCandidate(cand.id)}
              className={`border rounded-lg p-3 transition-all cursor-pointer ${
                isSelected
                  ? 'border-indigo-500/80 bg-indigo-50/40 ring-1 ring-indigo-500/20'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={isSelected ? `Deselect ${cand.label}` : `Select ${cand.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCandidate(cand.id);
                  }}
                  className="mt-0.5 p-0.5 -m-0.5 text-indigo-600 cursor-pointer"
                >
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 fill-indigo-600 text-white" aria-hidden="true" />
                  ) : (
                    <Square className="w-4 h-4 text-slate-400" aria-hidden="true" />
                  )}
                </button>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900">{cand.label}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">
                      {cand.representation === 'PDF_TEXT_OBJECT' ? 'PDF Text' : 'Image Region'}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-500 leading-snug">{cand.explanation}</p>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-[10px] font-medium text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                      Pages: {cand.pages.join(', ')}
                    </span>
                    {cand.rotation !== undefined && cand.rotation !== 0 && (
                      <span className="text-[10px] font-medium text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                        Angle: {cand.rotation}°
                      </span>
                    )}
                    {cand.fontSize && (
                      <span className="text-[10px] font-medium text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                        Size: {cand.fontSize}pt
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Manual regions summary (raster documents only) */}
        {showManualRegions &&
          manualRegions.map((m, idx) => (
            <div
              key={m.id}
              className="border border-rose-200 bg-rose-50/50 rounded-lg p-3 flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <MousePointerSquareDashed className="w-3.5 h-3.5 text-rose-500" aria-hidden="true" />
                <span className="text-xs font-semibold text-rose-900">
                  Manual Selection #{idx + 1}
                </span>
              </div>
              <span className="text-[10px] font-medium text-rose-700 bg-rose-100 px-2 py-0.5 rounded">
                Page {m.page}
              </span>
            </div>
          ))}

        {candidates.length === 0 && manualRegions.length === 0 && (
          <p className="text-xs text-slate-500 py-2">
            No watermark elements detected.{' '}
            {showManualRegions
              ? 'Draw a manual selection on the document to target a region.'
              : ''}
          </p>
        )}
      </div>

      {/* Removal method: truthful description of what the engine will do.
          The method is determined by the document type, so it is information,
          not a selectable option. */}
      <div className="border-t border-slate-100 pt-4">
        <span className="text-xs font-bold text-slate-800 block mb-2">Removal Method</span>
        <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/60 flex items-start gap-2">
          {isRasterDocument ? (
            <Image className="w-3.5 h-3.5 text-indigo-600 mt-0.5 shrink-0" aria-hidden="true" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-indigo-600 mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <p className="text-[11px] text-slate-600 leading-snug">
            {isRasterDocument ? (
              <>
                <span className="font-semibold text-slate-800">Localized restoration.</span> The
                selected region is rebuilt from the surrounding background. Other pixels stay
                untouched.
              </>
            ) : (
              <>
                <span className="font-semibold text-slate-800">Native editing.</span> Watermark
                elements are removed from the document structure. Text, fonts, links, and page
                layout remain fully intact.
              </>
            )}
          </p>
        </div>
      </div>

      {/* Execute CTA */}
      <div className="pt-2">
        <button
          type="button"
          onClick={onExecuteProcess}
          disabled={totalSelected === 0 || isProcessing}
          className="w-full py-3 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <Eraser className="w-4 h-4 animate-pulse" aria-hidden="true" />
              <span>Removing watermark…</span>
            </>
          ) : (
            <>
              <Eraser className="w-4 h-4" aria-hidden="true" />
              <span>
                {totalSelected === 0
                  ? 'Select a watermark to remove'
                  : `Remove ${totalSelected} Selected Target${totalSelected !== 1 ? 's' : ''}`}
              </span>
            </>
          )}
        </button>

        <p className="text-[11px] text-slate-400 text-center mt-2 flex items-center justify-center gap-1">
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          The result is independently verified before download is released.
        </p>
      </div>
    </div>
  );
};
