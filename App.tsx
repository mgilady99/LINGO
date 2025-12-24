import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  X,
} from 'lucide-react';

// ייבוא ההגדרות מהקובץ ששלחת לי
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';

import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

// מודל מעודכן ויציב
const MODEL_NAME = 'models/gemini-1.5-flash-002';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'en') || SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'he') || SUPPORTED_LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // פונקציית עצירה נקייה
  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) {
      try { activeSessionRef.current.close(); } catch {}
      activeSessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const startConversation = useCallback(async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('API Key חסר בהגדרות Cloudflare. וודא שהגדרת VITE_API_KEY.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      stopConversation();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const genAI = new GoogleGenAI({ apiKey });
      
      // אתחול סאונד
      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const session = await genAI.live.connect({
        model: MODEL_NAME,
        config: { 
          systemInstruction: `Mode: ${selectedScenario.title}. Native language: ${nativeLang.name}, Target language: ${targetLang.name}. Speak naturally and briefly.` 
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const proc = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            proc.onaudioprocess = (e) => {
              if (activeSessionRef.current && !isMuted) {
                try {
                  activeSessionRef.current.sendRealtimeInput({ 
                    media: createPcmBlob(e.inputBuffer.getChannelData(0)) 
                  });
                } catch {}
              }
            };
            source.connect(proc);
            proc.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (m: any) => {
            // טיפול באודיו חוזר
            const parts = m.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                setIsSpeaking(true);
                const audioBuffer = await decodeAudioData(outputAudioContextRef.current!, part.inlineData.data);
                const src = outputAudioContextRef.current!.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(outputAudioContextRef.current!.destination);
                
                const startAt = Math.max(outputAudioContextRef.current!.currentTime, nextStartTimeRef.current);
                src.start(startAt);
                nextStartTimeRef.current = startAt + audioBuffer.duration;
                
                sourcesRef.current.add(src);
                src.onended = () => {
                  sourcesRef.current.delete(src);
                  if (sourcesRef.current.size === 0) setIsSpeaking(false);
                };
              }
            }
          },
          onerror: (e) => {
            console.error("Session Error:", e);
            setError("החיבור הופסק. בדוק את מכסת ה-API או את ה-Billing.");
            stopConversation();
          },
          onclose: () => stopConversation()
        }
      });

      activeSessionRef.current = session;
    } catch (e) {
      setError("גישה למיקרופון נכשלה. וודא שאישרת הרשאות בדפדפן.");
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 flex flex-col md:flex-row overflow-hidden font-sans">
      {/* SIDEBAR */}
      <aside className="w-80 bg-slate-900 p-6 border-r border-white/5 flex flex-col gap-6 hidden md:flex">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                <Headphones className="text-white" />
            </div>
            <h1 className="text-xl font-black tracking-tight">LingoLive</h1>
          </div>
          <button onClick={() => setIsSettingsOpen(true)} className="p-2 border border-white/10 rounded-xl hover:bg-slate-800 transition"><Settings size={18} /></button>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Learn</label>
            <select className="w-full bg-slate-950 border border-slate-700 p-2 rounded-lg text-xs" value={targetLang.code} onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          
          <div className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Native</label>
            <select className="w-full bg-slate-950 border border-slate-700 p-2 rounded-lg text-xs" value={nativeLang.code} onChange={e => setNativeLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>

          <div className="pt-4 space-y-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Mode</label>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left text-xs transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                <span className="mr-2">{s.icon}</span> {s.title}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* MAIN AREA */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/10 text-[10px] font-bold">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          {status}
        </div>

        <div className="w-full max-w-md aspect-square flex items-center justify-center">
             <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        </div>

        <div className="mt-8 text-center space-y-2">
          <h2 className="text-3xl font-black">{isSpeaking ? 'Gemini Speaking...' : status === ConnectionStatus.CONNECTED ? 'Listening...' : selectedScenario.title}</h2>
          {error && <p className="text-red-400 text-xs bg-red-500/10 p-3 rounded-xl border border-red-500/20 max-w-sm mx-auto flex items-center gap-2"><AlertCircle size={14}/> {error}</p>}
        </div>

        <div className="mt-10 flex gap-4">
          {status === ConnectionStatus.CONNECTED ? (
            <>
              <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-3 rounded-2xl font-bold flex items-center gap-2 border transition ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700'}`}>
                {isMuted ? <MicOff size={20}/> : <Mic size={20}/>} {isMuted ? 'UNMUTE' : 'MUTE'}
              </button>
              <button onClick={stopConversation} className="px-8 py-3 bg-red-600 hover:bg-red-700 rounded-2xl font-bold flex items-center gap-2 text-white transition"><LogOut size={20}/> STOP</button>
            </>
          ) : (
            <button onClick={startConversation} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-3xl font-black text-lg shadow-2xl shadow-indigo-900/40 transition-all active:scale-95">START SESSION</button>
          )}
        </div>
      </main>

      {/* MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setIsSettingsOpen(false)}>
          <div className="bg-slate-900 p-8 rounded-3xl w-full max-w-md border border-white/10" onClick={e => e.stopPropagation()}>
             <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black">Settings</h3>
                <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-white/5 rounded-lg"><X/></button>
             </div>
             <p className="text-slate-400 text-sm mb-6">All changes are applied in real-time.</p>
             <button onClick={() => setIsSettingsOpen(false)} className="w-full bg-indigo-600 py-3 rounded-xl font-bold hover:bg-indigo-500 transition">Close</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
