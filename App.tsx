import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Settings, X } from 'lucide-react';

// שימוש ב-Types מהקובץ שלך
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';
import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

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
      setError('API Key is missing in Cloudflare environment settings.');
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

      const session = await genAI.live.connect({
        model: MODEL_NAME,
        config: { 
          systemInstruction: `You are a ${selectedScenario.title}. Native language: ${nativeLang.name}, Target language: ${targetLang.name}. Answer in short, natural sentences.` 
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
            // ✅ וידוא שקיימת תגובת אודיו מהמודל
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
            console.error("API Error:", e);
            setError("Session failed. Check your API quota or Billing settings.");
            stopConversation();
          },
          onclose: () => stopConversation()
        }
      });

      activeSessionRef.current = session;
    } catch (e) {
      setError("Microphone access denied.");
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 flex flex-col md:flex-row overflow-hidden font-sans">
      <aside className="w-80 bg-slate-900 p-6 border-r border-white/5 flex flex-col gap-6 hidden md:flex">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
            <h1 className="text-xl font-black">LingoLive</h1>
          </div>
          <button onClick={() => setIsSettingsOpen(true)} className="p-2 border border-white/10 rounded-xl hover:bg-slate-800 transition"><Settings size={18} /></button>
        </div>
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Learning</label>
            <select className="w-full bg-slate-950 border border-slate-700 p-2 rounded-lg text-xs" value={targetLang.code} onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          <div className="pt-4 space-y-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Practice Mode</label>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left text-xs transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                {s.icon} {s.title}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/10 text-[10px] font-bold">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          {status}
        </div>

        {/* הצגת האווטאר */}
        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />

        <div className="mt-8 text-center space-y-2">
          <h2 className="text-3xl font-black">{isSpeaking ? 'Gemini Speaking...' : status === ConnectionStatus.CONNECTED ? 'Listening...' : 'Welcome to LingoLive'}</h2>
          {error && <p className="text-red-400 text-xs bg-red-500/10 p-3 rounded-xl border border-red-500/20 flex items-center gap-2 max-w-sm mx-auto"><AlertCircle size={14}/> {error}</p>}
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
            <button onClick={startConversation} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-3xl font-black text-lg shadow-xl active:scale-95 transition-all">START LIVE SESSION</button>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
