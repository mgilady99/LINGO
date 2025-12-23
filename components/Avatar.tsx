

import React from 'react';

interface AvatarProps { state: 'idle' | 'listening' | 'speaking' | 'thinking'; }

const Avatar: React.FC<AvatarProps> = ({ state }) => {
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  
  return (
    <div className="relative w-72 h-72">
      <div className={`absolute inset-0 rounded-full blur-3xl opacity-20 transition-all duration-700 ${isSpeaking ? 'bg-indigo-500 scale-125' : isListening ? 'bg-emerald-500 scale-110' : 'bg-slate-700'}`} />
      <div className="relative w-full h-full rounded-full border-4 border-slate-800 overflow-hidden bg-slate-900 z-10">
        <img src="https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=600" className={`w-full h-full object-cover transition-transform duration-500 ${isSpeaking ? 'scale-110 animate-pulse' : 'scale-100'}`} />
        {state === 'thinking' && (
          <div className="absolute inset-0 bg-indigo-900/40 backdrop-blur-sm flex items-center justify-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
            <div className="w-2 h-2 bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
            <div className="w-2 h-2 bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
          </div>
        )}
      </div>
    </div>
  );
};

export default Avatar;
