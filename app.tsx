

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Headphones, AlertCircle, XCircle } from 'lucide-react';
import { ConnectionStatus, SUPPORTED_LANGUAGES, SCENARIOS, Language, PracticeScenario } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioService';
import Avatar from './components/Avatar';
import AudioVisualizer from './components/AudioVisualizer';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) {
      try { activeSessionRef.current.close(); } catch (e) {}
      activeSessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  useEffect(() => {
    return () => stopConversation();
  }, [stopConversation]);

  const startConversation = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setError('Missing API Key. Ensure it is set in environment variables.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey });
      
      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      await inputAudioContextRef.current.resume();
      await outputAudioContextRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      const outputCtx = outputAudioContextRef.current;
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);

      // Advanced Instructions for high-fidelity translation and deep persona
      let systemInstruction = `You are a sophisticated AI partner with a deep, sultry, and confident American female voice. 
      - PERSONA: Intelligent, warm, and highly accurate. Speak with a clear, deep American accent.
      - MODE: ${selectedScenario.title}. 
      - MISSION: Provide high-quality, relevant conversation. Always answer to the point.
      - LANGUAGES: Target is ${targetLang.name}, User native is ${nativeLang.name}.`;
      
      if (selectedScenario.id === 'translator') {
        systemInstruction = `You are an elite Simultaneous Interpreter. 
        - CRITICAL RULE: Translate EVERYTHING the user says without exception. 
        - ACCURACY: 1:1 literal translation. Do NOT summarize. Do NOT omit words. 
        - SPEED: Respond instantly. 
        - OUTPUT: Speak ONLY the translated text in the opposite language (if user speaks ${nativeLang.name}, translate to ${targetLang.name} and vice versa). 
        - VOICE: Keep your deep, sultry American female tone even while translating.`;
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-3-pro-preview', // Upgraded to Gemini 3 Pro
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              sessionPromise.then(s => {
                if (!isMuted && s) s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
            const audioData = m.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setIsSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputNode);
              source.onended = () => { 
                sourcesRef.current.delete(source); 
                if (sourcesRef.current.size === 0) setIsSpeaking(false); 
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
          },
          onerror: (e) => { 
            setError('Connection error. Your Pro API key might be required.'); 
            stopConversation(); 
          },
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED)
        },
        config: { 
          responseModalities: [Modality.AUDIO], 
          systemInstruction,
          thinkingConfig: { thinkingBudget: 1500 }, // Added thinking budget for Pro-level reasoning and translation accuracy
          speechConfig: { 
            voiceConfig: { 
              prebuiltVoiceConfig: { voiceName: 'Zephyr' } // Deep American Female
            } 
          }
        }
      });
      activeSessionRef.current = await sessionPromise;
    } catch (e) { 
      setError('Mic access denied or API error.'); 
      setStatus(ConnectionStatus.ERROR); 
    }
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col text-slate-200 overflow-hidden safe-area-inset">
      {/* Top Navigation */}
      <header className="p-4 flex items-center justify-between bg-slate-900/50 border-b border-white/5">
        <div className="flex items-center gap-2">
           <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(79,70,229,0.5)]"><Headphones size={16} /></div>
           <div className="flex flex-col">
             <span className="font-black text-xs tracking-tight">LingoLive</span>
             <span className="text-[8px] text-indigo-400 font-bold tracking-widest uppercase">Gemini 3 Pro Active</span>
           </div>
        </div>
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse shadow-[0_0_8px_#22c55e]' : 'bg-slate-700'}`} />
          <span className="text-[10px] font-bold opacity-60 uppercase tracking-tighter">{status}</span>
          {status === ConnectionStatus.CONNECTED && (
             <button onClick={stopConversation} className="ml-2 text-red-400 hover:text-red-300"><XCircle size={20} /></button>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col items-center justify-start p-4 gap-4 overflow-y-auto scrollbar-thin">
        
        {/* Settings Row */}
        <div className="w-full max-w-lg bg-slate-900/80 backdrop-blur-md rounded-2xl border border-white/10 p-2 flex items-center gap-2 shadow-2xl">
          <div className="flex-1 flex gap-1">
            <select 
              value={targetLang.code} 
              onChange={e => setTargetLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)} 
              disabled={status !== ConnectionStatus.DISCONNECTED}
              className="w-1/2 bg-slate-800 border-none rounded-xl py-2 px-1 text-[11px] font-bold focus:ring-1 focus:ring-indigo-500 outline-none transition-colors"
            >
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name.substring(0,3)}</option>)}
            </select>
            <select 
              value={nativeLang.code} 
              onChange={e => setNativeLang(SUPPORTED_LANGUAGES.find(l => l.code === e.target.value)!)} 
              disabled={status !== ConnectionStatus.DISCONNECTED}
              className="w-1/2 bg-slate-800 border-none rounded-xl py-2 px-1 text-[11px] font-bold focus:ring-1 focus:ring-indigo-500 outline-none transition-colors"
            >
              {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name.substring(0,3)}</option>)}
            </select>
          </div>
          
          <div className="flex gap-1 items-center px-1 border-l border-white/10">
            {SCENARIOS.map(s => (
              <button 
                key={s.id} 
                onClick={() => setSelectedScenario(s)} 
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${selectedScenario.id === s.id ? 'bg-indigo-600 text-white shadow-[0_0_15px_rgba(79,70,229,0.4)] scale-110' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                title={s.title}
              >
                <span className="text-sm">{s.icon}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Action Center: Start/Stop Buttons ABOVE Avatar */}
        <div className="w-full flex flex-col items-center gap-4 py-2">
          {error && (
            <div className="text-red-400 text-[10px] font-bold bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20 flex items-center gap-2 animate-bounce">
              <AlertCircle size={12} /> {error}
            </div>
          )}

          <div className="flex items-center gap-4">
            {status === ConnectionStatus.CONNECTED ? (
              <>
                <button 
                  onClick={() => setIsMuted(!isMuted)} 
                  className={`p-4 rounded-full border-2 transition-all shadow-lg ${isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 active:scale-90'}`}
                >
                  {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>
                <button onClick={stopConversation} className="bg-red-600 px-8 py-4 rounded-2xl font-black text-sm hover:bg-red-700 transition-all shadow-xl active:scale-95">
                   STOP SESSION
                </button>
              </>
            ) : (
              <button 
                onClick={startConversation} 
                disabled={status === ConnectionStatus.CONNECTING} 
                className="bg-indigo-600 px-12 py-5 rounded-3xl font-black flex items-center gap-3 text-lg shadow-[0_10px_30px_rgba(79,70,229,0.4)] hover:bg-indigo-500 transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
              >
                <Mic size={24} /> {status === ConnectionStatus.CONNECTING ? 'UPGRADING...' : 'START PRO MODE'}
              </button>
            )}
          </div>
        </div>

        {/* Visual Center */}
        <div className="flex-1 flex flex-col items-center justify-center w-full max-w-sm gap-4">
           <div className="text-center">
             <h2 className="text-xl font-black text-white tracking-tight">{selectedScenario.title}</h2>
             <p className="text-indigo-400/80 text-[10px] uppercase font-bold tracking-[0.2em]">
               {isSpeaking ? 'AI is processing with deep reasoning' : 'Speak clearly now'}
             </p>
           </div>
           
           <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
           
           {(isSpeaking || (status === ConnectionStatus.CONNECTED && !isMuted)) && (
             <div className="h-8">
               <AudioVisualizer isActive={true} color={isSpeaking ? "#6366f1" : "#10b981"} />
             </div>
           )}
        </div>
      </main>
    </div>
  );
};

export default App;
