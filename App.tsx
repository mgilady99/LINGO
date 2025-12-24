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

// מודל ה-Live היציב ביותר לשימוש ב-2025
const LIVE_MODEL = 'gemini-2.0-flash-exp'; 

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

  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopConversation = useCallback(() => {
    if (socketRef.current) { socketRef.current.close(); socketRef.current = null; }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
  }, []);

  const startConversation = useCallback(async () => {
    stopConversation();
    setError('');
    const apiKey = (import.meta as any).env?.VITE_API_KEY;
    
    if (!apiKey) {
      setError('Missing API Key in environment variables.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    setStatus(ConnectionStatus.CONNECTING);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      // חיבור WebSocket ישיר ל-v1beta של גוגל
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        // שליחת הודעת הגדרה (Setup)
        const setupMessage = {
          setup: {
            model: `models/${LIVE_MODEL}`,
            generation_config: { response_modalities: ["AUDIO"] },
            system_instruction: { parts: [{ text: `Mode: ${selectedScenario.title}. Native: ${nativeLang.name}, Learn: ${targetLang.name}.` }] }
          }
        };
        ws.send(JSON.stringify(setupMessage));
        
        // חיבור המיקרופון
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN && !isMuted) {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
            }
            const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
            ws.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: base64Audio, mime_type: "audio/pcm" }] } }));
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        setStatus(ConnectionStatus.CONNECTED);
      };

      ws.onmessage = async (event) => {
        const response = JSON.parse(event.data);
        const audioData = response.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
        if (audioData) {
          setIsSpeaking(true);
          const arrayBuffer = Uint8Array.from(atob(audioData), c => c.charCodeAt(0)).buffer;
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();
          source.onended = () => setIsSpeaking(false);
        }
      };

      ws.onerror = () => { setError('חיבור נכשל. וודא שמפתח ה-API תקין ומקושר ל-Billing.'); setStatus(ConnectionStatus.ERROR); stopConversation(); };
      ws.onclose = () => stopConversation();

    } catch (err) {
      setError('גישה למיקרופון נדחתה או שגיאת מערכת.');
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 overflow-hidden flex flex-col md:flex-row">
      {/* SIDEBAR */}
      <aside className="hidden md:flex w-[320px] bg-slate-900 border-r border-white/5 p-6 flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <div><div className="text-xl font-black">LingoLive</div><div className="text-[10px] text-slate-500 uppercase">AI Practice</div></div>
        </div>
        <div className="space-y-4">
          <div className="space-y-1"><label className="text-[10px] text-slate-400">Target Language</label>
            <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
          </div>
          <div className="space-y-2 pt-4">
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left flex items-center gap-3 ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                <span className="text-xl">{s.icon}</span><div className="font-bold text-xs">{s.title}</div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="flex-1 relative flex flex-col items-center justify-center p-6">
        <div className="absolute top-6 right-6 flex items-center gap-2 bg-slate-900/80 px-4 py-2 rounded-full border border-white/10 text-[10px] font-black uppercase tracking-widest">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`} />{status}
        </div>

        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />

        <div className="mt-8 text-center space-y-2">
          <h2 className="text-4xl font-black">{isSpeaking ? 'Gemini is speaking' : status === ConnectionStatus.CONNECTED ? 'Listening...' : selectedScenario.title}</h2>
          {error && <div className="text-red-400 text-xs bg-red-400/10 p-3 rounded-xl border border-red-400/20 max-w-md">{error}</div>}
        </div>

        <div className="mt-10 flex gap-4">
          {status === ConnectionStatus.CONNECTED ? (
            <>
              <button onClick={() => setIsMuted(!isMuted)} className={`px-6 py-3 rounded-2xl border-2 font-bold ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700'}`}>{isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'MIC OFF' : 'MIC ON'}</button>
              <button onClick={stopConversation} className="bg-red-600 px-8 py-3 rounded-2xl font-black flex items-center gap-2 hover:bg-red-700 transition shadow-xl"><LogOut size={18} /> STOP</button>
            </>
          ) : (
            <button onClick={startConversation} disabled={status === ConnectionStatus.CONNECTING} className="bg-indigo-600 px-16 py-5 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 transition active:scale-95">
              {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
