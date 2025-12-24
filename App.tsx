import React, { useState, useRef, useCallback } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, MicOff, Headphones, AlertCircle, Globe } from 'lucide-react';
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';
import Avatar from './components/avatar';

type Language = { code: string; name: string; flag: string };
enum ConnectionStatus { DISCONNECTED = 'DISCONNECTED', CONNECTING = 'CONNECTING', CONNECTED = 'CONNECTED', ERROR = 'ERROR' }

const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
];

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(LANGUAGES[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSessionRef = useRef<any>(null);

  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) { activeSessionRef.current.close(); activeSessionRef.current = null; }
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  const startConversation = async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY; 
    if (!apiKey) { setError('Missing VITE_API_KEY in Cloudflare.'); setStatus(ConnectionStatus.ERROR); return; }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI(apiKey);
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      const outputCtx = outputAudioContextRef.current;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const systemInstruction = `Translate between ${nativeLang.name} and ${targetLang.name}. Respond briefly via audio only.`;

      const conn = await (ai as any).live.connect({
        model: 'models/gemini-2.0-flash-exp',
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
            if (m instanceof Blob) return; // ✅ מונע שגיאת JSON וקריסת דיבור
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
          onerror: () => { setError('Connection lost.'); stopConversation(); }
        }
      });
      activeSessionRef.current = conn;
    } catch (e) { setError('Failed to connect.'); setStatus(ConnectionStatus.ERROR); }
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col md:flex-row text-slate-200">
      <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-6 flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg"><Headphones className="text-white" /></div>
          <h1 className="text-xl font-black italic">LingoLive AI</h1>
        </div>
        <div className="p-4 bg-slate-800/40 rounded-2xl border border-white/5 space-y-4">
          <select value={targetLang.code} onChange={e => setTargetLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
          </select>
          <select value={nativeLang.code} onChange={e => setNativeLang(LANGUAGES.find(l => l.code === e.target.value)!)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
          </select>
        </div>
      </aside>

      <main className="flex-1 flex flex-col items-center justify-center p-6 relative">
        <div className="w-full max-w-xl mb-12 text-center z-10">
          {status === ConnectionStatus.CONNECTED ? (
            <div className="flex gap-4 justify-center">
              <button onClick={() => setIsMuted(!isMuted)} className={`p-5 rounded-full border-2 ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700'}`}>
                {isMuted ? <MicOff size={24}/> : <Mic size={24}/>}
              </button>
              <button onClick={stopConversation} className="bg-red-600 px-10 py-5 rounded-2xl font-black shadow-xl">STOP</button>
            </div>
          ) : (
            <button onClick={startConversation} className="w-full bg-indigo-600 py-6 rounded-3xl font-black text-xl shadow-2xl hover:bg-indigo-500 transition">
              {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
            </button>
          )}
        </div>
        <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
        <div className="mt-8 text-center px-4">
          <h2 className="text-3xl md:text-5xl font-black text-white">{isSpeaking ? 'Gemini Speaking' : status === ConnectionStatus.CONNECTED ? 'Listening...' : 'Ready to Start?'}</h2>
          {error && <div className="mt-4 text-red-400 text-xs bg-red-400/10 p-3 rounded-xl border border-red-400/20 flex items-center gap-2 justify-center shadow-lg"><AlertCircle size={14}/> {error}</div>}
        </div>
      </main>
    </div>
  );
};

export default App;
