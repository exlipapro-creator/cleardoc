import React, { useState, useRef, useEffect } from 'react';
import {
  Columns2,
  SplitSquareVertical,
  Activity,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  CheckCircle2,
} from 'lucide-react';
import { DocumentRecord, VerificationResult } from '../../shared/types.js';

interface ComparisonViewerProps {
  document: DocumentRecord;
  verification: VerificationResult | null;
  currentPage: number;
  onPageChange: (page: number) => void;
}

export const ComparisonViewer: React.FC<ComparisonViewerProps> = ({
  document,
  verification,
  currentPage,
  onPageChange,
}) => {
  const [mode, setMode] = useState<'side-by-side' | 'slider' | 'diff'>('side-by-side');
  const [sliderPosition, setSliderPosition] = useState(50); // percentage 0 to 100
  const [isDraggingSlider, setIsDraggingSlider] = useState(false);
  const [zoom, setZoom] = useState(1.0);

  const sliderContainerRef = useRef<HTMLDivElement>(null);

  const handleSliderMove = (clientX: number) => {
    if (!sliderContainerRef.current) return;
    const rect = sliderContainerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPosition(pct);
  };

  const handleMouseDown = () => setIsDraggingSlider(true);
  const handleTouchStart = () => setIsDraggingSlider(true);

  useEffect(() => {
    const handleMouseUp = () => setIsDraggingSlider(false);
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingSlider) handleSliderMove(e.clientX);
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingSlider && e.touches[0]) handleSliderMove(e.touches[0].clientX);
    };

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchend', handleMouseUp);
    window.addEventListener('touchmove', handleTouchMove);

    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [isDraggingSlider]);

  const origUrl = `/api/documents/${document.id}/preview/${currentPage}?type=original`;
  const cleanUrl = `/api/documents/${document.id}/preview/${currentPage}?type=cleaned`;
  const diffUrl = `/api/documents/${document.id}/preview/${currentPage}?type=diff`;

  return (
    <div className="w-full bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs flex flex-col">
      {/* Top Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 gap-3">
        {/* Mode Selector Tabs */}
        <div className="flex items-center gap-1 bg-white p-1 rounded-lg border border-slate-200">
          <button
            type="button"
            onClick={() => setMode('side-by-side')}
            aria-pressed={mode === 'side-by-side'}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
              mode === 'side-by-side'
                ? 'bg-indigo-600 text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Side-by-Side</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('slider')}
            aria-pressed={mode === 'slider'}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
              mode === 'slider'
                ? 'bg-indigo-600 text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <SplitSquareVertical className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Split Slider</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('diff')}
            aria-pressed={mode === 'diff'}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
              mode === 'diff'
                ? 'bg-indigo-600 text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Diff Heatmap</span>
          </button>
        </div>

        {/* Page Switcher */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            aria-label="Previous Page"
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-30 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <span className="text-xs font-semibold text-slate-700">
            Page {currentPage} of {document.pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(document.pageCount, currentPage + 1))}
            disabled={currentPage >= document.pageCount}
            aria-label="Next Page"
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-30 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>

          <div className="h-4 w-px bg-slate-200 mx-1" />

          {/* Zoom Controls */}
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.6, z - 0.15))}
            aria-label="Zoom Out"
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-slate-600 font-mono w-9 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.0, z + 0.15))}
            aria-label="Zoom In"
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1.0)}
            aria-label="Reset Zoom"
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer"
            title="Reset Zoom"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Comparison Canvas */}
      <div className="bg-slate-200/50 p-6 flex justify-center items-start min-h-[500px] overflow-auto">
        {/* 1. Side-by-Side View */}
        {mode === 'side-by-side' && (
          <div
            className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-5xl transition-transform origin-top"
            style={{ transform: `scale(${zoom})` }}
          >
            <div className="bg-white rounded-lg shadow-md border border-slate-200 overflow-hidden flex flex-col">
              <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Original Document (Before)
                </span>
                <span className="text-[10px] font-semibold bg-rose-100 text-rose-800 px-2 py-0.5 rounded">
                  Watermark Active
                </span>
              </div>
              <div className="p-4 flex items-center justify-center bg-slate-50">
                <img
                  src={origUrl}
                  alt={`Original page ${currentPage}`}
                  className="max-w-full h-auto shadow-sm rounded select-none pointer-events-none"
                />
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-md border border-slate-200 overflow-hidden flex flex-col">
              <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-200/60 flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-900 uppercase tracking-wider flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Verified Output (After)
                </span>
                <span className="text-[10px] font-semibold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                  Cleaned
                </span>
              </div>
              <div className="p-4 flex items-center justify-center bg-slate-50">
                <img
                  src={cleanUrl}
                  alt={`Cleaned page ${currentPage}`}
                  className="max-w-full h-auto shadow-sm rounded select-none pointer-events-none"
                />
              </div>
            </div>
          </div>
        )}

        {/* 2. Interactive Split Slider View */}
        {mode === 'slider' && (
          <div
            ref={sliderContainerRef}
            className="relative max-w-[650px] w-full bg-white shadow-xl rounded-lg overflow-hidden border border-slate-300 select-none transition-transform origin-top"
            style={{ transform: `scale(${zoom})` }}
          >
            {/* Cleaned image (Bottom layer, revealed by slider) */}
            <img
              src={cleanUrl}
              alt="Cleaned document view"
              className="w-full h-auto block select-none pointer-events-none"
            />

            {/* Original image (Top layer with clip-path) */}
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
            >
              <img
                src={origUrl}
                alt="Original document view"
                className="w-full h-auto block select-none pointer-events-none"
              />
              <span className="absolute top-3 left-3 text-[10px] font-bold bg-slate-900/80 text-white px-2 py-0.5 rounded shadow-sm">
                BEFORE (Original)
              </span>
            </div>

            <span className="absolute top-3 right-3 text-[10px] font-bold bg-emerald-600/90 text-white px-2 py-0.5 rounded shadow-sm">
              AFTER (Cleaned)
            </span>

            {/* Draggable Divider Handle */}
            <div
              className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_10px_rgba(0,0,0,0.5)] cursor-ew-resize z-20 flex items-center justify-center"
              style={{ left: `${sliderPosition}%` }}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              <div className="w-7 h-7 rounded-full bg-white border-2 border-indigo-600 shadow-md flex items-center justify-center text-indigo-600 cursor-ew-resize">
                <SplitSquareVertical className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        )}

        {/* 3. Visual Diff Heatmap View */}
        {mode === 'diff' && (
          <div
            className="bg-white rounded-lg shadow-lg border border-slate-200 overflow-hidden max-w-[650px] w-full transition-transform origin-top"
            style={{ transform: `scale(${zoom})` }}
          >
            <div className="px-4 py-2.5 bg-slate-900 text-white flex items-center justify-between text-xs">
              <span className="font-bold flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" /> Difference Heatmap
              </span>
              <span className="font-mono text-slate-300">
                Red pixels indicate surgically removed regions
              </span>
            </div>
            <div className="p-4 flex items-center justify-center bg-slate-100">
              <img
                src={diffUrl}
                alt={`Pixel diff heatmap for page ${currentPage}`}
                className="max-w-full h-auto shadow-md rounded block select-none pointer-events-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
