import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  X,
  ChevronDown,
  PanelLeftOpen,
} from 'lucide-react';

import Avatar from './components/avatar';
import { createPcmBlob, decodeAudioData } from './services/audioservice';

// -------------------------
// Types & Constants
// -------------------------
type Language = { code: string; name: string; flag: string };
type Scenario = { id: 'translator' | 'chat' | 'expert'; title: string; description: string; icon: string };
enum ConnectionStatus { DISCONNECTED = 'DISCONNECTED', CONNECTING = 'CONNECTING', CONNECTED = 'CONNECTED', ERROR = 'ERROR' }

const LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
].sort((a, b) => a.name.localeCompare(b.name));

const SCENARIOS: Scenario[] = [
  { id: 'translator', title: 'Real-time Translator', description: 'Bi-directional translation.', icon: '🌐' },
  { id: 'chat', title: 'Casual Chat', description: 'Friendly conversation.', icon: '💬' },
  { id: 'expert', title: 'Expert Tutor', description: 'Intensive practice.', icon: '🎯' },
];

// מודל ה-Live המעודכן ל-2025
const LIVE_MODEL = 'models/gemini-2.0-flash-exp'; 

const CONTACT_EMAIL = 'callilcoil@gmail.com';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [error, setError] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [targetLang, setTargetLang] = useState<Language>(LANGUAGES.find(l => l.code === 'en') || LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(LANGUAGES.find(l => l.code === 'he') || LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<Scenario>(SCENARIOS[1]);
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [a11y, setA11y] = useState({ fontScale: 1, highContrast: false, reduceMotion: false });

  // Audio Refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);

  const stopConversation = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  const startConversation = useCallback(async () => {
    setError('');
    stopConversation();
    const apiKey = (import.meta as any).env?.VITE_API_KEY;
    if (!apiKey) { setError('Missing API Key.'); return; }

    setStatus(ConnectionStatus.CONNECTING);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = outputCtx;

      // חיבור WebSocket ישיר למניעת שגיאות SDK
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus(ConnectionStatus.CONNECTED);
        ws.send(JSON.stringify({
          setup: {
            model: LIVE_MODEL,
            generation_config: { response_modalities: ["AUDIO"] },
            system_instruction: { parts: [{ text: `Mode: ${selectedScenario.title}. Native: ${nativeLang.name}, Target: ${targetLang.name}.` }] }
          }
        }));

        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN && !isMuted) {
            const pcm16 = new Int16Array(e.inputBuffer.getChannelData(0).length);
            for (let i = 0; i < pcm16.length; i++) pcm16[i] = e.inputBuffer.getChannelData(0)[i] * 0x7FFF;
            ws.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer))), mime_type: "audio/pcm" }] } }));
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const audioBase64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioBase64) {
            setIsSpeaking(true);
            const buffer = await decodeAudioData(outputCtx, audioBase64);
            const source = outputCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(outputCtx.destination);
            const startAt = Math.max(outputCtx.currentTime, nextStartTimeRef.current);
            source.start(startAt);
            nextStartTimeRef.current = startAt + buffer.duration;
            source.onended = () => { if (outputCtx.currentTime >= nextStartTimeRef.current) setIsSpeaking(false); };
          }
        } catch {}
      };

      ws.onclose = () => stopConversation();
      ws.onerror = () => { setError('Connection error.'); stopConversation(); };

    } catch (err) {
      setError('Mic access denied.');
      setStatus(ConnectionStatus.ERROR);
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className={`h-dvh w-dvw bg-slate-950 text-slate-200 overflow-hidden flex flex-col md:flex-row ${a11y.highContrast ? 'contrast-125 saturate-125' : ''}`} style={{ fontSize: `${a11y.fontScale * 100}%` }}>
      {/* SIDEBAR */}
      <aside className="hidden md:flex w-80 bg-slate-900 border-r border-white/5 p-6 flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <div><div className="text-xl font-black">LingoLive</div><div className="text-[10px] text-slate-500">AI PRACTICE</div></div>
        </div>
        <div className="space-y-4">
            <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left flex items-center gap-3 ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                <span className="text-xl">{s.icon}</span><div className="font-bold text-xs">{s.title}</div>
              </button>
            ))}
        </div>
        <div className="mt-auto text-[11px] text-slate-500 flex justify-between">© 2025 LingoLive <Settings className="cursor-pointer" onClick={() => setIsSettingsOpen(true)} size={16}/></div>
      </aside>

      {/* MAIN VIEW */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        {/* Status Pill */}
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-full border border-white/10 text-[10px] font-black uppercase">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />{status}
        </div>

        {/* ✅ START BUTTON - עכשיו תמיד מעל האווטאר */}
        <div className="mb-10 w-full max-w-xl text-center">
            {status === ConnectionStatus.CONNECTED ? (
                <div className="flex gap-4 justify-center">
                    <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-3 rounded-2xl border-2 font-bold flex items-center gap-2 ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700'}`}>
                        {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'MIC OFF' : 'MIC ON'}
                    </button>
                    <button onClick={stopConversation} className="bg-red-600 px-8 py-3 rounded-2xl font-black text-white hover:bg-red-700 transition">STOP</button>
                </div>
            ) : (
                <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 transition active:scale-95">
                    {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
            )}
        </div>

        {/* ✅ AVATAR - עכשיו תחת הכפתור */}
        <div className="scale-90 md:scale-100">
          <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        </div>

        <div className="mt-8 text-center space-y-2">
          <h2 className="text-3xl font-black">{isSpeaking ? 'Gemini is speaking' : status === ConnectionStatus.CONNECTED ? 'Listening...' : selectedScenario.title}</h2>
          <p className="text-slate-500 max-w-md mx-auto">{selectedScenario.description}</p>
          {error && <div className="text-red-400 text-xs bg-red-400/10 p-3 rounded-xl border border-red-400/20 flex items-center gap-2 justify-center"><AlertCircle size={14}/> {error}</div>}
        </div>
      </main>
    </div>
  );
};

export default App;
