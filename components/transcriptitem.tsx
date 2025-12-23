

import React from 'react';
import { TranscriptionEntry } from '../types';
import { CheckCircle } from 'lucide-react';

interface TranscriptItemProps {
  entry: TranscriptionEntry;
}

const TranscriptItem: React.FC<TranscriptItemProps> = ({ entry }) => {
  const isUser = entry.role === 'user';
  const isRtl = /[\u0590-\u05FF]/.test(entry.text);

  return (
    <div className={`flex w-full mb-4 ${isUser ? 'justify-end' : 'justify-start'} animate-in`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-lg transition-all ${
        isUser 
          ? 'bg-indigo-600 text-white rounded-tr-none border border-indigo-500' 
          : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'
      }`}>
        <p className={`leading-relaxed text-base ${isRtl ? 'text-right' : 'text-left'}`} dir={isRtl ? 'rtl' : 'ltr'}>
          {entry.text}
        </p>
        
        {entry.correction && (
          <div className="mt-3 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-start gap-2">
            <CheckCircle size={14} className="text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-tighter block mb-0.5">Gemini Correction</span>
              <p className="text-emerald-100 text-sm leading-snug">{entry.correction}</p>
            </div>
          </div>
        )}

        <span className="text-[10px] mt-1.5 block opacity-50 text-right">
          {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
};

export default TranscriptItem;
