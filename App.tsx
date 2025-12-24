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
    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Cloudflare.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    setStatus(ConnectionStatus.CONNECTING);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = outputCtx;

      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus(ConnectionStatus.CONNECTED);
        ws.send(JSON.stringify({
          setup: {
            model: LIVE_MODEL,
            generation_config: { response_modalities: ["AUDIO"] },
            system_instruction: { parts: [{ text: `Mode: ${selectedScenario.title}. Native: ${nativeLang.name}, Target: ${targetLang.name}. Respond briefly.` }] }
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
      {/* SIDEBAR (Desktop) */}
      <aside className="hidden md:flex w-80 bg-slate-900 border-r border-white/5 p-6 flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <div><div className="text-xl font-black">LingoLive</div></div>
        </div>
        <div className="space-y-4">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>
            <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-4">Mode</div>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-3 rounded-xl border text-left flex items-center gap-3 transition ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800'}`}>
                <span className="text-xl">{s.icon}</span><div className="font-bold text-xs">{s.title}</div>
              </button>
            ))}
        </div>
        <div className="mt-auto flex justify-between text-[11px] text-slate-500">© 2025 LingoLive <Settings className="cursor-pointer" onClick={() => setIsSettingsOpen(true)} size={16}/></div>
      </aside>

      {/* MAIN AREA */}
      <main className="flex-1 flex flex-col items-center p-4 md:p-10 relative overflow-hidden">
        {/* Top bar (mobile menu trigger) */}
        <div className="md:hidden w-full flex justify-between items-center mb-6">
          <div className="text-lg font-black">LingoLive</div>
          <button onClick={() => setIsMobilePanelOpen(!isMobilePanelOpen)} className="flex items-center gap-2 bg-slate-800 px-4 py-2 rounded-xl text-xs font-bold border border-white/10">
            <PanelLeftOpen size={16}/> {isMobilePanelOpen ? 'Close' : 'Languages'}
          </button>
        </div>

        {/* Mobile Sidebar Overlay */}
        {isMobilePanelOpen && (
          <div className="md:hidden absolute inset-x-0 top-16 z-50 p-4 bg-slate-900/95 backdrop-blur-md border-b border-white/10 shadow-2xl animate-in slide-in-from-top duration-300">
            <div className="space-y-4">
               <div className="grid grid-cols-2 gap-4">
                  <div><label className="text-[10px] text-slate-500 font-bold uppercase">Learn</label>
                  <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none">
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                  </select></div>
                  <div><label className="text-[10px] text-slate-500 font-bold uppercase">Native</label>
                  <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none">
                    {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                  </select></div>
               </div>
               <div className="space-y-2">
                 {SCENARIOS.map(s => (
                  <button key={s.id} onClick={() => {setSelectedScenario(s); setIsMobilePanelOpen(false);}} className={`w-full p-3 rounded-xl border text-left flex items-center gap-3 ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent'}`}>
                    <span className="text-xl">{s.icon}</span><span className="font-bold text-xs">{s.title}</span>
                  </button>
                 ))}
               </div>
            </div>
          </div>
        )}

        {/* ✅ START BUTTON - עכשיו מעל האווטאר */}
        <div className="w-full max-w-xl mb-10 z-10">
            {status === ConnectionStatus.CONNECTED ? (
                <div className="flex gap-4 justify-center">
                    <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-4 rounded-3xl border-2 font-bold flex items-center gap-2 transition shadow-xl ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 hover:border-indigo-500'}`}>
                        {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'MIC OFF' : 'MIC ON'}
                    </button>
                    <button onClick={stopConversation} className="bg-red-600 px-10 py-4 rounded-3xl font-black text-white hover:bg-red-700 transition shadow-xl">STOP</button>
                </div>
            ) : (
                <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 transition active:scale-95 flex items-center justify-center gap-3">
                    <Mic size={24}/> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
            )}
        </div>

        {/* ✅ AVATAR - תחת הכפתור */}
        <div className="relative group mb-8">
           <div className={`absolute -inset-4 bg-indigo-500/20 rounded-full blur-2xl transition-opacity duration-1000 ${status === ConnectionStatus.CONNECTED ? 'opacity-100' : 'opacity-0'}`} />
           <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        </div>

        <div className="text-center space-y-2 max-w-md">
          <h2 className="text-3xl md:text-4xl font-black tracking-tight">{isSpeaking ? 'Gemini is speaking' : status === ConnectionStatus.CONNECTED ? 'Listening...' : selectedScenario.title}</h2>
          <p className="text-slate-500 text-sm md:text-base">{selectedScenario.description}</p>
          {error && <div className="text-red-400 text-xs bg-red-400/10 p-4 rounded-2xl border border-red-400/20 flex items-center gap-2 justify-center"><AlertCircle size={16}/> {error}</div>}
        </div>

        {/* Footer right links */}
        <div className="mt-auto pt-6 flex gap-6 text-[11px] text-slate-500 uppercase font-bold tracking-widest">
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition">Contact</a>
            <a href="/privacy" className="hover:text-white transition">Privacy</a>
        </div>
      </main>
    </div>
  );
};

export default App;
