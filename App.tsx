import React, { useCallback, useRef, useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Globe } from 'lucide-react';

// ייבוא מהקבצים הקיימים בפרויקט שלך
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';
import { createPcmBlob, decodeAudioData } from './services/audioservice';
import Avatar from './components/avatar';

// ✅ זהו השם המדויק הנדרש עבור ה-Live API בגרסת הביתא
const MODEL_NAME = 'models/gemini-1.5-flash';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  
  // ✅ הגדרת שתי שפות: שפת אם ושפת יעד
  const [nativeLang, setNativeLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'he') || SUPPORTED_LANGUAGES[0]);
  const [targetLang, setTargetLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find(l => l.code === 'en') || SUPPORTED_LANGUAGES[0]);
  
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // פונקציית עצירה נקייה שמונעת את הלופ האדום שראית בתמונה
  const stopConversation = useCallback(() => {
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
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const startConversation = useCallback(async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('Missing API Key. Ensure VITE_API_KEY is configured in Cloudflare.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      stopConversation();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const genAI = new GoogleGenAI({ apiKey });
      if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const session = await genAI.live.connect({
        model: MODEL_NAME,
        config: { 
          // ✅ הנחיה למודל לתרגם בין שתי השפות שבחרת
          systemInstruction: `You are a ${selectedScenario.title}. Translate between ${nativeLang.name} and ${targetLang.name}. Respond briefly and naturally.` 
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const proc = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            audioProcessorRef.current = proc;
            
            proc.onaudioprocess = (e) => {
              // הגנה: שולח אודיו רק אם החיבור פתוח באמת
              if (activeSessionRef.current && activeSessionRef.current.readyState === 1 && !isMuted) {
                try {
                  activeSessionRef.current.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
                } catch { stopConversation(); }
              }
            };
            source.connect(proc);
            proc.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (m: any) => {
            const parts = m?.serverContent?.modelTurn?.parts;
            if (parts && Array.isArray(parts)) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  setIsSpeaking(true);
                  const audioBuffer = await decodeAudioData(outputAudioCtxRef.current!, part.inlineData.data);
                  const src = outputAudioCtxRef.current!.createBufferSource();
                  src.buffer = audioBuffer;
                  src.connect(outputAudioCtxRef.current!.destination);
                  const startAt = Math.max(outputAudioCtxRef.current!.currentTime, nextStartTimeRef.current);
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
            setError("Connection failed. Check Billing linkage in Google Cloud Console.");
            stopConversation();
          },
          onclose: (e) => {
            if (e?.code === 1008) setError("Policy violation (1008): Link Billing to your project.");
            stopConversation();
          }
        }
      });
      activeSessionRef.current = session;
    } catch (e) {
      setError("Mic access denied. Please allow microphone permissions.");
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang, targetLang, selectedScenario, isMuted, stopConversation]);

  return (
    <div className="h-dvh w-dvw bg-slate-950 text-slate-200 flex flex-col md:flex-row overflow-hidden font-sans">
      {/* SIDEBAR */}
      <aside className="w-80 bg-slate-900 p-6 border-r border-white/5 flex flex-col gap-8 hidden md:flex shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-900/20">
            <Headphones className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tighter text-white">LingoLive</h1>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">AI Voice Tutor</p>
          </div>
        </div>
        
        <div className="space-y-6">
          {/* שדות השפות */}
          <div className="space-y-4">
            <div className="space-y-2">
               <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-2">
                 <Globe size={12}/> Your Native Language
               </label>
               <select className="w-full bg-slate-950 border border-slate-800 p-3 rounded-xl text-sm focus:border-indigo-500 outline-none transition-all" value={nativeLang.code} onChange={e => setNativeLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
                 {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
               </select>
            </div>

            <div className="space-y-2">
               <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-2">
                 <Globe size={12}/> Target Language
               </label>
               <select className="w-full bg-slate-950 border border-slate-800 p-3 rounded-xl text-sm focus:border-indigo-500 outline-none transition-all" value={targetLang.code} onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)}>
                 {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
               </select>
            </div>
          </div>

          <div className="pt-4 space-y-3">
            <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Practice Mode</label>
            {SCENARIOS.map(s => (
              <button key={s.id} onClick={() => setSelectedScenario(s)} className={`w-full p-4 rounded-2xl border text-left text-xs transition-all duration-300 ${selectedScenario.id === s.id ? 'bg-indigo-600/10 border-indigo-500 text-white shadow-[0_0_20px_rgba(79,70,229,0.1)]' : 'bg-slate-800/30 border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
                <div className="flex items-center gap-3">
                  <span className="text-xl">{s.icon}</span>
                  <div>
                    <div className="font-
