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

// ייבוא מסודר מהקובץ ששלחת
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';

import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

// שימוש במודל היציב ביותר
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
      setError('Missing API Key. Please configure it in Cloudflare.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      stopConversation();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const genAI = new GoogleGenAI({ apiKey });
      
      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // חיבור לסשן ה-Live
      const session = await genAI.live.connect({
        model: MODEL_NAME,
        config: { 
          systemInstruction: `You are a ${selectedScenario.title}. Native language: ${nativeLang.name}, Target language: ${targetLang.name}. Answer briefly.` 
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const proc = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            proc.onaudioprocess = (e) => {
              if (activeSessionRef.current && status === ConnectionStatus.CONNECTED && !isMuted) {
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
            // ✅ תיקון השגיאה: וידוא מבנה ההודעה לפני עיבוד
            const parts = m?.serverContent?.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
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
            }
          },
          onerror: (e) => {
            console.error("Session Error:", e);
            setError("Connection error. Check your API limit.");
            stopConversation();
          },
          onclose: () => stopConversation()
        }
      });

      activeSessionRef.current = session;
    } catch (e) {
      setError("Microphone access failed.");
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation, status]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 flex flex-col md:flex-row overflow-hidden">
      {/* SIDEBAR */}
      <aside className="w-80 bg-slate-900 p-6 border-r border-white/5 flex flex-col gap-6 hidden md:flex">
        <div className="flex items-center gap-3">
          <Headphones className="text-indigo-500" />
          <h1 className="text-xl font-black">LingoLive</h1>
        </div>
        <div className="space-y-4">
          <label className="text-[10px] text-slate-500 font-bold uppercase">Learning</label>
          <select className="w-full bg-slate-800 p-2 rounded-lg text-sm" value={targetLang.code} onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
            {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
          </select>
          <div className="pt-4 space-y-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Mode</label>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left text-xs transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                {s.icon} {s.title}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/10 text-[10px] font-bold">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          {status}
        </div>

        {/* הצגת האווטאר - שלח לי את הקוד שלו אם הוא לא מופיע */}
        <div className="w-64 h-64 mb-8">
            <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        </div>

        <div className="text-center space-y-4">
          <h2 className="text-3xl font-black tracking-tight">{isSpeaking ? 'Gemini Speaking...' : 'LingoLive'}</h2>
          {error && <p className="text-red-400 text-xs bg-red-500/10 p-2 rounded border border-red-500/20">{error}</p>}
        </div>

        <div className="mt-10 flex gap-4">
          {status === ConnectionStatus.CONNECTED ? (
            <>
              <button onClick={() => setIsMuted(!isMuted)} className="px-8 py-3 bg-slate-800 rounded-2xl font-bold flex items-center gap-2 border border-slate-700 hover:border-indigo-500 transition">
                {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'UNMUTE' : 'MUTE'}
              </button>
              <button onClick={stopConversation} className="px-8 py-3 bg-red-600 hover:bg-red-700 rounded-2xl font-bold flex items-center gap-2 text-white"><LogOut/> STOP</button>
            </>
          ) : (
            <button onClick={startConversation} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-3xl font-black text-lg shadow-xl active:scale-95 transition-all">START SESSION</button>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
