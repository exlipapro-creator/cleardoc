import React from 'react';
import { Lock, Shield, Cpu } from 'lucide-react';

export const PrivacyFooter: React.FC = () => {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white py-8 text-xs text-slate-500">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Privacy Commitment */}
        <div className="flex items-center gap-2 text-center md:text-left">
          <Shield className="w-4 h-4 text-emerald-600 shrink-0" />
          <p>
            <span className="font-semibold text-slate-700">Privacy Guarantee:</span> ClearDoc operates strictly in isolated temporary containers. Uploaded documents are never permanently retained or stored for analytics, and all temporary artifacts are automatically purged.
          </p>
        </div>

        {/* Engine Specs */}
        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400 shrink-0">
          <span className="flex items-center gap-1">
            <Cpu className="w-3.5 h-3.5 text-slate-400" />
            <span>v1.0.0</span>
          </span>
          <span>•</span>
          <span>Native Stream Surgery</span>
          <span>•</span>
          <span>WCAG 2.2 AA</span>
        </div>
      </div>
    </footer>
  );
};
