import React, { useRef, useState } from 'react';
import { UploadCloud, FileType, AlertCircle, FileSpreadsheet, ShieldCheck, CheckCircle2 } from 'lucide-react';

interface UploadDropzoneProps {
  onFileUpload: (file: File) => void;
  onLoadSample: (type: 'draft' | 'confidential' | 'clean' | 'image') => void;
  isUploading: boolean;
  uploadProgress: number;
}

export const UploadDropzone: React.FC<UploadDropzoneProps> = ({
  onFileUpload,
  onLoadSample,
  isUploading,
  uploadProgress,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const validateAndUpload = (file: File) => {
    setErrorMessage(null);

    const validExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif'];
    const lowerName = file.name.toLowerCase();
    const hasValidExt = validExtensions.some((ext) => lowerName.endsWith(ext));

    if (!hasValidExt) {
      setErrorMessage(
        'Unsupported file format. ClearDoc accepts PDF documents and standard raster images (PNG, JPEG, WEBP, TIFF).'
      );
      return;
    }

    if (file.size > 30 * 1024 * 1024) {
      setErrorMessage('File exceeds maximum size limit of 30 MB.');
      return;
    }

    onFileUpload(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndUpload(e.target.files[0]);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      {/* Hero Headline */}
      <div className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
          Remove Document Watermarks with Precision
        </h1>
        <p className="mt-3 text-base text-slate-600 max-w-2xl mx-auto">
          ClearDoc identifies watermark elements and removes them using the least destructive method available.
          Native PDF structure, fonts, page dimensions, and non-watermark content remain fully preserved.
        </p>
      </div>

      {/* Main Drag-and-Drop Area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isUploading) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        tabIndex={0}
        role="button"
        aria-label="Upload document for precision watermark removal"
        className={`relative border-2 border-dashed rounded-xl p-8 sm:p-12 text-center transition-all cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-600 ${
          isDragOver
            ? 'border-indigo-500 bg-indigo-50/60 shadow-md scale-[1.005]'
            : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50/50 shadow-xs'
        } ${isUploading ? 'pointer-events-none opacity-80' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.tiff,.tif"
          onChange={handleFileInputChange}
          className="hidden"
          disabled={isUploading}
        />

        {isUploading ? (
          <div className="space-y-4 py-4">
            <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center mx-auto animate-pulse">
              <UploadCloud className="w-6 h-6 animate-bounce" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">Ingesting & Validating Document...</p>
              <p className="text-xs text-slate-500 mt-1">Verifying signatures and checking magic bytes</p>
            </div>
            <div className="w-64 h-2 bg-slate-200 rounded-full mx-auto overflow-hidden">
              <div
                className="h-full bg-indigo-600 rounded-full transition-all duration-300"
                style={{ width: `${Math.max(10, uploadProgress)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto border border-indigo-100 shadow-2xs">
              <UploadCloud className="w-7 h-7 stroke-[1.8]" />
            </div>
            <div>
              <p className="text-base font-semibold text-slate-800">
                Click to browse or drop document here
              </p>
              <p className="text-xs text-slate-500 mt-1">
                PDF (native vector/text, scanned), PNG, JPEG, WEBP, TIFF up to 30 MB
              </p>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-medium">
              <FileType className="w-3.5 h-3.5 text-slate-400" />
              <span>Native PDF surgical editing priority</span>
            </div>
          </div>
        )}
      </div>

      {/* Client validation error */}
      {errorMessage && (
        <div className="mt-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Immediate Test Fixtures Panel */}
      <div className="mt-6 bg-slate-50 border border-slate-200 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-indigo-600" aria-hidden="true" />
            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Sample Documents
            </span>
          </div>
          <span className="text-xs text-slate-500 hidden sm:inline">
            Load controlled reproducible test documents
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLoadSample('draft');
            }}
            disabled={isUploading}
            className="flex flex-col text-left p-3 rounded-lg bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-xs transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-800 group-hover:text-indigo-600">
                Financial Report
              </span>
              <span className="text-[10px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded border border-amber-200/60">
                DRAFT
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              2-page native PDF with diagonal 45° watermark across pages.
            </p>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLoadSample('confidential');
            }}
            disabled={isUploading}
            className="flex flex-col text-left p-3 rounded-lg bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-xs transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-800 group-hover:text-indigo-600">
                Patent Agreement
              </span>
              <span className="text-[10px] font-bold bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded border border-rose-200/60">
                CONFIDENTIAL
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Legal agreement with centered watermark and formatted clauses.
            </p>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLoadSample('image');
            }}
            disabled={isUploading}
            className="flex flex-col text-left p-3 rounded-lg bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-xs transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-800 group-hover:text-indigo-600">
                Blueprint Image
              </span>
              <span className="text-[10px] font-bold bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200/60">
                RASTER
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              High-res PNG diagram with stamped watermark overlay.
            </p>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLoadSample('clean');
            }}
            disabled={isUploading}
            className="flex flex-col text-left p-3 rounded-lg bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-xs transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-800 group-hover:text-indigo-600">
                Clean Document
              </span>
              <span className="text-[10px] font-bold bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200">
                NO WATERMARK
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Verifies honest detector: reports 0 candidates without false positives.
            </p>
          </button>
        </div>
      </div>

      {/* Privacy and Preservation Pillars */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
        <div className="p-4 rounded-lg bg-white border border-slate-200/80 shadow-2xs">
          <div className="w-7 h-7 rounded-md bg-emerald-50 text-emerald-600 flex items-center justify-center mb-2">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
            Native-First Surgery
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Modifies content streams directly. Fonts, vectors, annotations, and hyperlinks remain untouched.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-white border border-slate-200/80 shadow-2xs">
          <div className="w-7 h-7 rounded-md bg-indigo-50 text-indigo-600 flex items-center justify-center mb-2">
            <FileSpreadsheet className="w-4 h-4" />
          </div>
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
            Mandatory Verification
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Dual structural and pixel-level audit. Residual watermark search and unexpected change detection.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-white border border-slate-200/80 shadow-2xs">
          <div className="w-7 h-7 rounded-md bg-amber-50 text-amber-600 flex items-center justify-center mb-2">
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          </div>
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
            Honest Classification
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Downloads are gated behind verified PASS results. Ambiguous modifications trigger manual review.
          </p>
        </div>
      </div>
    </div>
  );
};
