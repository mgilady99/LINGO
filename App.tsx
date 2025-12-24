import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Settings, X, Globe, PanelLeftOpen } from 'lucide-react';
import Avatar from './components/avatar';
import { decodeAudioData } from './services/audioservice';

// Types
type Language = { code: string; name: string; flag: string };
type Scenario = { id: string; title: string; description: string; icon: string };
enum ConnectionStatus { DISCONNECTED = 'DISCONNECTED', CONNECTING = 'CONNECTING', CONNECTED = 'CONNECTED', ERROR = 'ERROR' }

const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
].sort((a, b) => a.name.localeCompare(b.name));

const SCENARIOS: Scenario[] = [
  { id: 'translator', title: 'Real-time Translator', description: 'Bi-directional translation.', icon: '🌐' },
  { id: 'chat', title: 'Casual Chat', description: 'Friendly conversation.', icon: '💬' },
  { id: 'expert', title: 'Expert Tutor', description: 'Intensive practice.', icon: '🎯' },
];

const LIVE_MODEL = 'models/gemini-2.0-flash-exp';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [error, setError] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  
  // ✅ 2 שדות שפה
  const [targetLang, setTargetLang] = useState<Language>(LANGUAGES.find(l => l.code === 'en') || LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(LANGUAGES.find(l => l.code === 'he') || LANGUAGES[0]);
  
  const [selectedScenario, setSelectedScenario] = useState<Scenario>(SCENARIOS[1]);
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);

  const stopConversation = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    if (audioCtxRef.current) audioCtxRef.current.close();
    wsRef.current = null;
    audioCtxRef.current = null;
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
      const inputCtx = new AudioContext({ sampleRate: 16000 });
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
            system_instruction: { parts: [{ text: `You are a ${selectedScenario.title}. Native: ${nativeLang.name}, Target: ${targetLang.name}. Respond ONLY with audio.` }] }
          }
        }));

        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN && !isMuted) {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < pcm16.length; i++) pcm16[i] = inputData[i] * 0x7FFF;
            ws.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer))), mime_type: "audio/pcm" }] } }));
          }
        };
        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = async (ev) => {
        // ✅ טיפול בשגיאת ה-[object Blob] - מזהה אם הגיע מידע בינארי ומתעלם ממנו כדי לא לקרוס
        if (ev.data instanceof Blob) return;
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
            source.onended = () => { if (outputCtx.currentTime >= nextStartTimeRef.current - 0.1) setIsSpeaking(false); };
          }
        } catch (e) {}
      };

      ws.onclose = () => stopConversation();
      ws.onerror = () => { setError('Connection error.'); stopConversation(); };
    } catch (err) { setError('Mic access denied.'); setStatus(ConnectionStatus.ERROR); }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 overflow-hidden flex flex-col md:flex-row">
      {/* SIDEBAR (Desktop) */}
      <aside className="hidden md:flex w-80 bg-slate-900 border-r border-white/5 p-6 flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20"><Headphones className="text-white" /></div>
          <h1 className="text-xl font-black italic">LingoLive</h1>
        </div>
        <div className="space-y-6">
            <div className="space-y-2">
               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2"><Globe size={12}/> Your Languages</label>
               <div className="space-y-2">
                 <div className="text-[9px] text-slate-400">Target</div>
                 <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
                   {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                 </select>
                 <div className="text-[9px] text-slate-400">Native</div>
                 <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
                   {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                 </select>
               </div>
            </div>
            <div className="space-y-2">
              {SCENARIOS.map(s => (
                <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-4 rounded-xl border text-left flex items-center gap-3 transition-all ${selectedScenario.id === s.id ? 'bg-indigo-600/20 border-indigo-500 text-white' : 'bg-slate-800/40 border-transparent text-slate-400 hover:bg-slate-800'}`}>
                  <span className="text-xl">{s.icon}</span><span className="font-bold text-xs">{s.title}</span>
                </button>
              ))}
            </div>
        </div>
      </aside>

      {/* MAIN VIEW */}
      <main className="flex-1 flex flex-col items-center p-4 md:p-10 relative overflow-y-auto">
        <div className="md:hidden w-full flex justify-between items-center mb-8">
          <h1 className="text-xl font-black italic">LingoLive</h1>
          <button onClick={() => setIsMobilePanelOpen(!isMobilePanelOpen)} className="bg-slate-800 px-4 py-2 rounded-xl text-xs font-bold border border-white/10 flex items-center gap-2">
            <PanelLeftOpen size={16}/> Settings
          </button>
        </div>

        {/* ✅ Mobile Overlay Panel - כאן מופיעות 2 השפות במובייל */}
        {isMobilePanelOpen && (
          <div className="md:hidden absolute inset-x-0 top-16 z-50 p-6 bg-slate-900 border-b border-white/10 shadow-2xl space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><div className="text-[9px] text-slate-400 mb-1">Learn</div>
              <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs">
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select></div>
              <div><div className="text-[9px] text-slate-400 mb-1">Native</div>
              <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs">
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select></div>
            </div>
            <button onClick={() => setIsMobilePanelOpen(false)} className="w-full py-3 bg-indigo-600 rounded-xl font-bold text-xs">Close Settings</button>
          </div>
        )}

        {/* ✅ START/STOP BUTTON - מעל האווטאר */}
        <div className="w-full max-w-xl mb-12 z-10">
            {status === ConnectionStatus.CONNECTED ? (
                <div className="flex gap-4 justify-center">
                    <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-4 rounded-3xl border-2 font-black flex items-center gap-3 shadow-xl ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700'}`}>
                        {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'OFF' : 'ON'}
                    </button>
                    <button onClick={stopConversation} className="bg-red-600 px-10 py-4 rounded-3xl font-black text-white shadow-xl hover:bg-red-700">STOP</button>
                </div>
            ) : (
                <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 transition-all active:scale-95 flex justify-center items-center gap-3" disabled={status === ConnectionStatus.CONNECTING}>
                   <Mic size={24}/> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
            )}
        </div>

        {/* ✅ AVATAR - מתחת לכפתור */}
        <div className="relative mb-10">
           <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        </div>

        <div className="text-center space-y-2 max-w-md px-4">
          <h2 className="text-3xl md:text-5xl font-black tracking-tighter leading-none mb-2 text-white">
            {isSpeaking ? 'Gemini Speaking' : status === ConnectionStatus.CONNECTED ? 'I am listening...' : selectedScenario.title}
          </h2>
          <p className="text-slate-500 text-sm md:text-base font-medium">{selectedScenario.description}</p>
          {error && <div className="mt-4 text-red-400 text-xs bg-red-400/10 p-4 rounded-2xl border border-red-400/20 flex items-center gap-3 justify-center shadow-lg"><AlertCircle size={18}/> {error}</div>}
        </div>
      </main>
    </div>
  );
};

export default App;
