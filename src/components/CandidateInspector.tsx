import React from 'react';
import {
  CheckSquare,
  Square,
  Wand2,
  FileText,
  Layers,
  ArrowRight,
  Info,
  CheckCircle2,
} from 'lucide-react';
import {
  WatermarkCandidate,
  RemovalStrategy,
  ManualRegion,
} from '../../shared/types.js';

interface CandidateInspectorProps {
  candidates: WatermarkCandidate[];
  selectedCandidateIds: string[];
  onToggleCandidate: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  manualRegions: ManualRegion[];
  preferredStrategy: RemovalStrategy;
  onStrategyChange: (strategy: RemovalStrategy) => void;
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
  preferredStrategy,
  onStrategyChange,
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
            Review proposed removal targets before execution
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
                  aria-label={isSelected ? `Deselect ${cand.label}` : `Select ${cand.label}`}
                  className="mt-0.5 text-indigo-600 cursor-pointer"
                >
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 fill-indigo-600 text-white" />
                  ) : (
                    <Square className="w-4 h-4 text-slate-400" />
                  )}
                </button>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">{cand.label}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                      {cand.representation}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-500 leading-snug">{cand.explanation}</p>

                  <div className="flex items-center gap-2 pt-1">
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

        {/* Manual regions summary */}
        {manualRegions.map((m, idx) => (
          <div
            key={m.id}
            className="border border-rose-200 bg-rose-50/50 rounded-lg p-3 flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="text-xs font-semibold text-rose-900">
                Manual Selection Region #{idx + 1}
              </span>
            </div>
            <span className="text-[10px] font-medium text-rose-700 bg-rose-100 px-2 py-0.5 rounded">
              Page {m.page} ({m.bbox.width}×{m.bbox.height}pt)
            </span>
          </div>
        ))}
      </div>

      {/* Strategy Selector */}
      <div className="border-t border-slate-100 pt-4">
        <label className="text-xs font-bold text-slate-800 block mb-2">
          Least-Destructive Removal Strategy
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onStrategyChange('NATIVE_OBJECT_REMOVAL')}
            className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
              preferredStrategy === 'NATIVE_OBJECT_REMOVAL'
                ? 'border-indigo-600 bg-indigo-50/50 ring-1 ring-indigo-500/20'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <FileText className="w-3.5 h-3.5 text-indigo-600" />
              <span className="text-xs font-bold text-slate-900">Native PDF Surgery</span>
            </div>
            <p className="text-[11px] text-slate-500">
              Modifies stream operators. Full preservation of text, fonts, and page structure.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onStrategyChange('LOCALIZED_RASTER_RESTORATION')}
            className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
              preferredStrategy === 'LOCALIZED_RASTER_RESTORATION'
                ? 'border-indigo-600 bg-indigo-50/50 ring-1 ring-indigo-500/20'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
              <span className="text-xs font-bold text-slate-900">Localized Restoration</span>
            </div>
            <p className="text-[11px] text-slate-500">
              For rasterized stamps. Interpolates local background strictly within target bounding box.
            </p>
          </button>
        </div>
      </div>

      {/* Execute Plan CTA */}
      <div className="pt-2">
        <button
          type="button"
          onClick={onExecuteProcess}
          disabled={totalSelected === 0 || isProcessing}
          className="w-full py-3 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-xs transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center gap-2"
        >
          <Wand2 className="w-4 h-4" />
          <span>
            {isProcessing
              ? 'Executing Removal Plan...'
              : `Execute Removal Plan (${totalSelected} target${totalSelected !== 1 ? 's' : ''})`}
          </span>
          <ArrowRight className="w-4 h-4 ml-1" />
        </button>

        <p className="text-[11px] text-slate-400 text-center mt-2 flex items-center justify-center gap-1">
          <Info className="w-3.5 h-3.5" />
          Result will be independently verified before release.
        </p>
      </div>
    </div>
  );
};
