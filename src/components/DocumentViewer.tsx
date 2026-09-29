import React, { useState, useRef, useEffect } from 'react';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Trash2,
  Maximize2,
} from 'lucide-react';
import { DocumentRecord, WatermarkCandidate, ManualRegion } from '../../shared/types.js';

interface DocumentViewerProps {
  document: DocumentRecord;
  currentPage: number;
  onPageChange: (page: number) => void;
  candidates: WatermarkCandidate[];
  selectedCandidateIds: string[];
  onToggleCandidate: (id: string) => void;
  manualRegions: ManualRegion[];
  onAddManualRegion: (region: ManualRegion) => void;
  onRemoveManualRegion: (id: string) => void;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  document,
  currentPage,
  onPageChange,
  candidates,
  selectedCandidateIds,
  onToggleCandidate,
  manualRegions,
  onAddManualRegion,
  onRemoveManualRegion,
}) => {
  const [zoom, setZoom] = useState(1.0);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [drawingStart, setDrawingStart] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Filter candidates relevant to active page
  const pageCandidates = candidates.filter((c) => c.pages.includes(currentPage));
  const pageManualRegions = manualRegions.filter((m) => m.page === currentPage);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingMode || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    setDrawingStart({ x, y });
    setCurrentRect({ x, y, width: 0, height: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingMode || !drawingStart || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    const x = Math.min(drawingStart.x, currentX);
    const y = Math.min(drawingStart.y, currentY);
    const width = Math.abs(currentX - drawingStart.x);
    const height = Math.abs(currentY - drawingStart.y);

    setCurrentRect({ x, y, width, height });
  };

  const handleMouseUp = () => {
    if (!isDrawingMode || !drawingStart || !currentRect || !imageRef.current) {
      setDrawingStart(null);
      setCurrentRect(null);
      return;
    }

    if (currentRect.width > 15 && currentRect.height > 15) {
      const rect = imageRef.current.getBoundingClientRect();
      const pageDim = document.dimensions[currentPage - 1] || { width: 595, height: 842 };

      // Convert rendered DOM coordinates to native PDF points
      const scaleX = pageDim.width / rect.width;
      const scaleY = pageDim.height / rect.height;

      const newRegion: ManualRegion = {
        id: `manual_${Date.now()}`,
        page: currentPage,
        bbox: {
          x: Math.round(currentRect.x * scaleX),
          y: Math.round(currentRect.y * scaleY),
          width: Math.round(currentRect.width * scaleX),
          height: Math.round(currentRect.height * scaleY),
        },
      };

      onAddManualRegion(newRegion);
    }

    setDrawingStart(null);
    setCurrentRect(null);
    setIsDrawingMode(false);
  };

  const activeDim = document.dimensions[currentPage - 1] || { width: 595, height: 842 };

  return (
    <div className="flex flex-col lg:flex-row gap-6 w-full">
      {/* Thumbnails Sidebar (for multi-page documents) */}
      {document.pageCount > 1 && (
        <aside
          aria-label="Document Page Navigation"
          className="lg:w-44 flex lg:flex-col gap-3 overflow-x-auto lg:overflow-y-auto max-h-[600px] p-2 bg-slate-100 rounded-xl border border-slate-200/80 shrink-0"
        >
          {Array.from({ length: document.pageCount }).map((_, idx) => {
            const pageNum = idx + 1;
            const isSelected = pageNum === currentPage;
            return (
              <button
                key={pageNum}
                type="button"
                onClick={() => onPageChange(pageNum)}
                aria-label={`View page ${pageNum}`}
                aria-current={isSelected ? 'page' : undefined}
                className={`relative flex flex-col items-center p-2 rounded-lg border text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'border-indigo-600 bg-white ring-2 ring-indigo-500/30 shadow-xs'
                    : 'border-slate-200 bg-slate-50 hover:bg-white hover:border-slate-300'
                }`}
              >
                <div className="w-28 h-36 bg-white border border-slate-200 shadow-2xs overflow-hidden rounded relative">
                  <img
                    src={`/api/documents/${document.id}/preview/${pageNum}?type=original`}
                    alt={`Thumbnail for page ${pageNum}`}
                    className="w-full h-full object-contain pointer-events-none"
                    loading="lazy"
                  />
                </div>
                <span className="text-[11px] font-semibold text-slate-700 mt-1.5">
                  Page {pageNum}
                </span>
              </button>
            );
          })}
        </aside>
      )}

      {/* Main Preview Container */}
      <div className="flex-1 flex flex-col bg-slate-900/5 border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
          {/* Page controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous Page"
              className="p-1 rounded hover:bg-slate-100 text-slate-700 disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-slate-700">
              Page {currentPage} of {document.pageCount}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(document.pageCount, currentPage + 1))}
              disabled={currentPage >= document.pageCount}
              aria-label="Next Page"
              className="p-1 rounded hover:bg-slate-100 text-slate-700 disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Drawing & Zoom controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsDrawingMode(!isDrawingMode)}
              aria-pressed={isDrawingMode}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                isDrawingMode
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>{isDrawingMode ? 'Drawing Area...' : 'Manual Selection'}</span>
            </button>

            <div className="h-4 w-px bg-slate-200 mx-1" />

            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.6, z - 0.15))}
              aria-label="Zoom Out"
              className="p-1 rounded hover:bg-slate-100 text-slate-700 cursor-pointer"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-600 font-mono w-10 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))}
              aria-label="Zoom In"
              className="p-1 rounded hover:bg-slate-100 text-slate-700 cursor-pointer"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1.0)}
              aria-label="Reset Zoom"
              className="p-1 rounded hover:bg-slate-100 text-slate-700 cursor-pointer"
              title="Reset Zoom"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Viewport Canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto p-6 flex justify-center items-center min-h-[460px] bg-slate-200/50"
        >
          <div
            className="relative shadow-lg bg-white rounded transition-transform origin-top"
            style={{ transform: `scale(${zoom})` }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            {/* Rendered page image */}
            <img
              ref={imageRef}
              src={`/api/documents/${document.id}/preview/${currentPage}?type=original`}
              alt={`Page ${currentPage} document view`}
              className="max-w-[700px] w-full h-auto block select-none pointer-events-none"
            />

            {/* Candidate Watermark Bounding Boxes Overlay */}
            {pageCandidates.map((cand) => {
              const isSelected = selectedCandidateIds.includes(cand.id);
              // Calculate percentage positions relative to native page dimensions
              const leftPct = (cand.bbox.x / activeDim.width) * 100;
              const topPct = (cand.bbox.y / activeDim.height) * 100;
              const widthPct = (cand.bbox.width / activeDim.width) * 100;
              const heightPct = (cand.bbox.height / activeDim.height) * 100;

              return (
                <div
                  key={cand.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isDrawingMode) onToggleCandidate(cand.id);
                  }}
                  className={`absolute border-2 rounded transition-all cursor-pointer group ${
                    isSelected
                      ? 'border-indigo-600 bg-indigo-500/20 shadow-sm'
                      : 'border-slate-400/80 bg-slate-500/10 hover:border-slate-600'
                  }`}
                  style={{
                    left: `${Math.max(0, leftPct)}%`,
                    top: `${Math.max(0, topPct)}%`,
                    width: `${Math.min(100, widthPct)}%`,
                    height: `${Math.min(100, heightPct)}%`,
                  }}
                  title={`${cand.label} — Click to ${isSelected ? 'deselect' : 'select'}`}
                >
                  <span
                    className={`absolute -top-5 left-0 text-[10px] font-bold px-1.5 py-0.5 rounded shadow-xs whitespace-nowrap ${
                      isSelected
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-700 text-slate-100'
                    }`}
                  >
                    {cand.type === 'DIAGONAL_TEXT' ? '↗ ' : ''}
                    {cand.label}
                  </span>
                </div>
              );
            })}

            {/* Manual user-selected regions overlay */}
            {pageManualRegions.map((m) => {
              const leftPct = (m.bbox.x / activeDim.width) * 100;
              const topPct = (m.bbox.y / activeDim.height) * 100;
              const widthPct = (m.bbox.width / activeDim.width) * 100;
              const heightPct = (m.bbox.height / activeDim.height) * 100;

              return (
                <div
                  key={m.id}
                  className="absolute border-2 border-rose-500 bg-rose-500/20 rounded z-10 flex items-start justify-end p-1"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    width: `${widthPct}%`,
                    height: `${heightPct}%`,
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveManualRegion(m.id);
                    }}
                    className="p-1 rounded bg-rose-600 hover:bg-rose-700 text-white shadow-xs cursor-pointer"
                    title="Remove this manual region"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}

            {/* Active Drawing Box */}
            {isDrawingMode && currentRect && (
              <div
                className="absolute border-2 border-dashed border-rose-600 bg-rose-500/25 pointer-events-none rounded"
                style={{
                  left: `${currentRect.x}px`,
                  top: `${currentRect.y}px`,
                  width: `${currentRect.width}px`,
                  height: `${currentRect.height}px`,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
