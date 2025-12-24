import React, { useCallback, useRef, useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Settings, X } from 'lucide-react';

// ייבוא מהקובץ types.ts שלך
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';
import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

// ✅ זהו השם המדויק הנדרש עבור ה-Live API
const MODEL_NAME = 'models/gemini-1.5-flash';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'en') || SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'he') || SUPPORTED_LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const stopConversation = useCallback(() => {
    // 1. ניתוק המיקרופון מיד כדי למנוע את הלופ האדום בקונסול
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current = null;
    }
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
    setIsSpeaking(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const startConversation = useCallback(async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('Missing API Key (VITE_API_KEY).');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      stopConversation();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const genAI = new GoogleGenAI({ apiKey });
      if (!inputCtxRef.current) inputCtxRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputCtxRef.current) outputCtxRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const session = await genAI.live.connect({
        model: MODEL_NAME,
        config: { 
          systemInstruction: `You are a ${selectedScenario.title}. Native: ${nativeLang.name}, Target: ${targetLang.name}. Respond very briefly.` 
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputCtxRef.current!.createMediaStreamSource(stream);
            const proc = inputCtxRef.current!.createScriptProcessor(4096, 1, 1);
            audioProcessorRef.current = proc;
            
            proc.onaudioprocess = (e) => {
              // הגנה: שולח רק אם ה-WebSocket פתוח
              if (activeSessionRef.current && !isMuted) {
                try {
                  activeSessionRef.current.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
                } catch { stopConversation(); }
              }
            };
            source.connect(proc);
            proc.connect(inputCtxRef.current!.destination);
          },
          onmessage: async (m: any) => {
            const parts = m?.serverContent?.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  setIsSpeaking(true);
                  const audioBuffer = await decodeAudioData(outputCtxRef.current!, part.inlineData.data);
                  const src = outputCtxRef.current!.createBufferSource();
                  src.buffer = audioBuffer;
                  src.connect(outputCtxRef.current!.destination);
                  const startAt = Math.max(outputCtxRef.current!.currentTime, nextStartTimeRef.current);
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
            console.error("Critical API Error:", e);
            setError("Connection failed. Check if API Key matches a Paid Project.");
            stopConversation();
          },
          onclose: (e) => {
            if (e?.code === 1008) setError("Policy violation (1008): Project not on Paid Plan.");
            stopConversation();
          }
        }
      });
      activeSessionRef.current = session;
    } catch (e) {
      setError("Mic access denied.");
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 flex flex-col md:flex-row overflow-hidden font-sans">
      <aside className="w-80 bg-slate-900 p-6 border-r border-white/5 flex flex-col gap-6 hidden md:flex">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <h1 className="text-xl font-black tracking-tighter">LingoLive</h1>
        </div>
        <div className="space-y-4">
          <div className="space-y-1">
             <label className="text-[10px] text-slate-500 font-bold uppercase">Learning</label>
             <select className="w-full bg-slate-950 border border-slate-700 p-2 rounded-lg text-xs" value={targetLang.code} onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
               {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
             </select>
          </div>
          <div className="pt-4 space-y-2">
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left text-xs transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>{s.icon} {s.title}</button>
            ))}
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/10 text-[10px] font-bold">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          {status}
        </div>
        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        <div className="mt-8 text-center">
          <h2 className="text-3xl font-black mb-2 tracking-tight">{isSpeaking ? 'Gemini Speaking...' : 'LingoLive'}</h2>
          {error && <div className="text-red-400 text-[10px] bg-red-500/10 p-3 rounded-xl border border-red-500/20 max-w-sm mx-auto flex items-center gap-2"><AlertCircle size={14}/> {error}</div>}
        </div>
        <div className="mt-10">
          {status === ConnectionStatus.CONNECTED ? (
            <button onClick={stopConversation} className="px-12 py-4 bg-red-600 hover:bg-red-700 rounded-3xl font-black text-lg transition shadow-xl">STOP SESSION</button>
          ) : (
            <button onClick={startConversation} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-3xl font-black text-lg shadow-xl active:scale-95 transition-all">START SESSION</button>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
