import React, { useCallback, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Globe } from 'lucide-react';
import Avatar from './components/avatar';
import { decodeAudioData } from './services/audioservice';

type Language = { code: string; name: string; flag: string };
enum ConnectionStatus { DISCONNECTED = 'DISCONNECTED', CONNECTING = 'CONNECTING', CONNECTED = 'CONNECTED', ERROR = 'ERROR' }

const LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'zh', name: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
];

const LIVE_MODEL = 'models/gemini-2.0-flash-exp';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [error, setError] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  
  const [targetLang, setTargetLang] = useState<Language>(LANGUAGES[2]); // English
  const [nativeLang, setNativeLang] = useState<Language>(LANGUAGES[5]); // Hebrew

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
            system_instruction: { parts: [{ text: `Translate between ${nativeLang.name} and ${targetLang.name}. Respond only via audio.` }] }
          }
        }));

        const inputCtx = new AudioContext({ sampleRate: 16000 });
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
        if (ev.data instanceof Blob) return; // הגנה משגיאת "Unexpected token 'o'"
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
    } catch (err) { setError('Mic access denied.'); setStatus(ConnectionStatus.ERROR); }
  }, [nativeLang, targetLang, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 overflow-hidden flex flex-col md:flex-row">
      <aside className="hidden md:flex w-80 bg-slate-900 border-r border-white/5 p-6 flex-col gap-6">
        <div className="flex items-center gap-3"><div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div><h1 className="text-xl font-black italic">LingoLive</h1></div>
        <div className="space-y-4">
            <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2"><Globe size={12}/> Target</label>
            <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs outline-none focus:border-indigo-500">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
            <label className="text-[10px] font-bold text-slate-500 uppercase mt-4 block">Native</label>
            <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs outline-none focus:border-indigo-500">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
            </select>
        </div>
      </aside>

      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="w-full max-w-xl mb-12 z-10 text-center">
            {status === ConnectionStatus.CONNECTED ? (
                <div className="flex gap-4 justify-center">
                    <button onClick={() => setIsMuted(!isMuted)} className={`px-8 py-4 rounded-3xl border-2 font-black flex items-center gap-3 shadow-xl ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700'}`}>
                        {isMuted ? <MicOff/> : <Mic/>} {isMuted ? 'OFF' : 'ON'}
                    </button>
                    <button onClick={stopConversation} className="bg-red-600 px-10 py-4 rounded-3xl font-black text-white shadow-xl hover:bg-red-700">STOP</button>
                </div>
            ) : (
                <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 active:scale-95 transition flex justify-center items-center gap-3 disabled:opacity-50" disabled={status === ConnectionStatus.CONNECTING}>
                   <Mic size={24}/> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
            )}
        </div>

        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />

        <div className="mt-8 text-center px-4">
          <h2 className="text-3xl md:text-5xl font-black text-white leading-tight">{isSpeaking ? 'Gemini Speaking' : 'LingoLive AI'}</h2>
          {error && <div className="mt-4 text-red-400 text-xs bg-red-400/10 p-4 rounded-2xl border border-red-400/20 flex items-center gap-3 justify-center shadow-lg animate-pulse"><AlertCircle size={18}/> {error}</div>}
        </div>
      </main>
    </div>
  );
};

export default App;
