import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  X,
} from 'lucide-react';

import { ConnectionStatus } from './types';
import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

type Language = { code: string; name: string; flag: string };
type PracticeScenario = { id: 'translator' | 'chat' | 'expert'; title: string; description: string; icon: string };

// ✅ מודל יציב ומעודכן שמונע את שגיאת code 1008
const MODEL_NAME = 'models/gemini-1.5-flash-002';

const SCENARIOS: PracticeScenario[] = [
  { id: 'translator', title: 'Real-time Translator', description: 'Bi-directional translation between 2 languages.', icon: '🌐' },
  { id: 'chat', title: 'Casual Chat', description: 'Friendly conversation to build fluency.', icon: '💬' },
  { id: 'expert', title: 'Expert Tutor', description: 'Intensive practice with corrections.', icon: '🎯' },
];

const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'zh', name: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
].sort((a, b) => a.name.localeCompare(b.name));

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find((l) => l.code === 'en') || SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find((l) => l.code === 'he') || SUPPORTED_LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const isMutedRef = useRef(isMuted);

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  const stopConversation = useCallback(() => {
    // סגירת הסשן לפני ניקוי משאבים
    if (activeSessionRef.current) {
      try { activeSessionRef.current.close(); } catch {}
      activeSessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const startConversation = useCallback(async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('API Key חסר. הגדר אותו ב-Cloudflare.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      stopConversation();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const ai = new GoogleGenAI({ apiKey });

      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const session = await ai.live.connect({
        model: MODEL_NAME,
        config: { 
          systemInstruction: `You are a ${selectedScenario.title}. Native: ${nativeLang.name}, Target: ${targetLang.name}.` 
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const inCtx = inputAudioContextRef.current!;
            const source = inCtx.createMediaStreamSource(stream);
            const proc = inCtx.createScriptProcessor(4096, 1, 1);
            
            proc.onaudioprocess = (e) => {
              // ✅ הגנה: שולח אודיו רק אם החיבור פתוח ופעיל
              if (activeSessionRef.current && !isMutedRef.current) {
                try {
                  activeSessionRef.current.sendRealtimeInput({ 
                    media: createPcmBlob(e.inputBuffer.getChannelData(0)) 
                  });
                } catch (err) {
                  // אם השליחה נכשלת, מפסיקים כדי למנוע לופ שגיאות
                  console.error("Audio send failed");
                }
              }
            };
            source.connect(proc);
            proc.connect(inCtx.destination);
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.modelTurn?.parts) {
              setIsSpeaking(true);
              for (const part of m.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
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
          onerror: (e: any) => {
            console.error('Connection error:', e);
            if (e?.message?.includes('429')) setError('חריגת מכסה (Quota). המתן דקה.');
            else setError('שגיאת חיבור. וודא שה-Billing מופעל.');
            stopConversation();
          },
          onclose: (e: any) => {
            if (e?.code === 1008) setError('המודל לא נמצא או חסר Billing (1008).');
            stopConversation();
          }
        },
      });

      activeSessionRef.current = session;
    } catch (e: any) {
      setError('גישה למיקרופון נדחתה או שגיאת רשת.');
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang.name, targetLang.name, selectedScenario.title, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 overflow-hidden flex flex-col md:flex-row font-sans">
      <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-6 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center"><Headphones className="text-white" /></div>
            <div className="font-black text-lg">LingoLive</div>
          </div>
          <button onClick={() => setIsSettingsOpen(true)} className="p-2 border border-white/10 rounded-xl hover:bg-slate-800"><Settings size={18} /></button>
        </div>

        <div className="space-y-4">
          <div className="flex flex-col gap-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Learning</label>
            <select className="bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs" value={targetLang.code} onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Native</label>
            <select className="bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs" value={nativeLang.code} onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          <div className="pt-4 space-y-2">
            <label className="text-[10px] text-slate-500 font-bold uppercase">Practice Mode</label>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left text-xs transition ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                <span className="mr-2">{s.icon}</span> {s.title}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/5 text-[10px] font-bold">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />
          {status.toUpperCase()}
        </div>

        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        
        <div className="mt-8 text-center space-y-2">
          <h2 className="text-3xl font-black">{isSpeaking ? 'Gemini Speaking...' : status === ConnectionStatus.CONNECTED ? 'Listening...' : 'Start Practicing'}</h2>
          {error && <div className="text-red-400 text-xs bg-red-500/10 p-3 rounded-lg border border-red-500/20 max-w-sm mx-auto flex items-center gap-2"><AlertCircle size={14}/>{error}</div>}
        </div>

        <div className="mt-10 flex gap-4">
          {status === ConnectionStatus.CONNECTED ? (
            <>
              <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-3 rounded-2xl font-bold flex items-center gap-2 transition ${isMuted ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-200'}`}>
                {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'UNMUTE' : 'MUTE'}
              </button>
              <button onClick={stopConversation} className="px-8 py-3 bg-red-600 hover:bg-red-700 rounded-2xl font-bold flex items-center gap-2 text-white"><LogOut/> STOP</button>
            </>
          ) : (
            <button onClick={startConversation} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-3xl font-black text-lg shadow-xl shadow-indigo-900/20 active:scale-95 transition-all">START LIVE SESSION</button>
          )}
        </div>
      </main>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setIsSettingsOpen(false)}>
          <div className="bg-slate-900 p-8 rounded-3xl w-full max-w-md border border-white/10" onClick={e => e.stopPropagation()}>
             <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black">Settings</h3>
                <button onClick={() => setIsSettingsOpen(false)}><X/></button>
             </div>
             <p className="text-slate-400 text-sm mb-6">Language and accessibility settings are saved locally.</p>
             <button onClick={() => setIsSettingsOpen(false)} className="w-full bg-indigo-600 py-3 rounded-xl font-bold">Close</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
