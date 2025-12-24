import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Globe, Settings } from 'lucide-react';
// ייבוא מקבצים באותיות קטנות כפי שהם שמורים ב-GitHub שלך
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';
import Avatar from './components/avatar';

type Language = { code: string; name: string; flag: string };
type Scenario = { id: string; title: string; description: string; icon: string };
enum ConnectionStatus { DISCONNECTED = 'DISCONNECTED', CONNECTING = 'CONNECTING', CONNECTED = 'CONNECTED', ERROR = 'ERROR' }

const LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' }, { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' }, { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' }, { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' }, { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' }, { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' }, { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' }, { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
];

const SCENARIOS: Scenario[] = [
  { id: 'translator', title: 'Real-time Translator', description: 'Bi-directional translation.', icon: '🌐' },
  { id: 'chat', title: 'Casual Chat', description: 'Friendly conversation.', icon: '💬' },
  { id: 'expert', title: 'Expert Tutor', description: 'Intensive practice.', icon: '🎯' },
];

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(LANGUAGES[2]); 
  const [nativeLang, setNativeLang] = useState<Language>(LANGUAGES[5]); 
  const [selectedScenario, setSelectedScenario] = useState<Scenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSessionRef = useRef<any>(null);

  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) { try { activeSessionRef.current.close(); } catch (e) {} activeSessionRef.current = null; }
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  const startConversation = async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY; // שימוש בנתיב Vite
    if (!apiKey) { setError('Missing VITE_API_KEY in Cloudflare.'); setStatus(ConnectionStatus.ERROR); return; }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI(apiKey);
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      const outputCtx = outputAudioContextRef.current;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const systemInstruction = `Mode: ${selectedScenario.title}. Translate between ${nativeLang.name} and ${targetLang.name}. Respond only via audio.`;

      const conn = await (ai as any).live.connect({
        model: 'models/gemini-2.0-flash-exp', // המודל היציב
        config: { systemInstruction: { parts: [{ text: systemInstruction }] } },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const inputCtx = new AudioContext({ sampleRate: 16000 });
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              if (!isMuted && activeSessionRef.current) {
                activeSessionRef.current.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
              }
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (m: any) => {
            if (m instanceof Blob) return; // ✅ התיקון שמונע את השגיאה בקונסול
            const audioData = m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setIsSpeaking(true);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              const startAt = Math.max(outputCtx.currentTime, nextStartTimeRef.current);
              source.start(startAt);
              nextStartTimeRef.current = startAt + buffer.duration;
              source.onended = () => { if (outputCtx.currentTime >= nextStartTimeRef.current - 0.1) setIsSpeaking(false); };
            }
          },
          onerror: () => { setError('Lost connection.'); stopConversation(); }
        }
      });
      activeSessionRef.current = conn;
    } catch (e) { setError('Failed to start session.'); setStatus(ConnectionStatus.ERROR); }
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col md:flex-row text-slate-200 overflow-hidden">
      <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-6 flex flex-col gap-6 shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <h1 className="text-xl font-black italic tracking-tighter">LingoLive AI</h1>
        </div>
        <div className="space-y-4">
          <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2"><Globe size={12}/> Languages</label>
          <div className="p-4 bg-slate-800/40 rounded-2xl border border-white/5 space-y-4">
            <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
            <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          <label className="text-[10px] font-bold text-slate-500 uppercase">Training Mode</label>
          <div className="space-y-2 overflow-y-auto max-h-64 scrollbar-thin">
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500 text-white' : 'bg-slate-800/40 border-transparent hover:bg-slate-800 text-slate-400'}`}>
                <span className="text-xl">{s.icon}</span>
                <div><div className="font-bold text-[10px]">{s.title}</div><div className="text-[8px] opacity-50">{s.description}</div></div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="w-full max-w-xl mb-12 z-10 text-center">
            {status === ConnectionStatus.CONNECTED ? (
                <div className="flex gap-4 justify-center">
                    <button onClick={() => setIsMuted(!isMuted)} className={`p-5 rounded-full border-2 transition-all ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700'}`}>
                        {isMuted ? <MicOff size={24}/> : <Mic size={24}/>}
                    </button>
                    <button onClick={stopConversation} className="bg-red-600 px-10 py-5 rounded-2xl font-black text-white shadow-xl hover:bg-red-700 transition">STOP</button>
                </div>
            ) : (
                <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 active:scale-95 transition-all">
                  {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
            )}
        </div>
        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        <div className="mt-8 text-center max-w-md px-4">
          <h2 className="text-3xl md:text-5xl font-black text-white tracking-tighter">{isSpeaking ? 'Gemini Speaking' : status === ConnectionStatus.CONNECTED ? 'Listening...' : selectedScenario.title}</h2>
          <p className="text-slate-500 text-sm mt-2">{selectedScenario.description}</p>
        </div>
        {error && <div className="mt-4 text-red-400 text-xs bg-red-400/10 p-3 rounded-xl border border-red-400/20 flex items-center gap-2 shadow-lg"><AlertCircle size={14}/> {error}</div>}
      </main>
    </div>
  );
};

export default App;
