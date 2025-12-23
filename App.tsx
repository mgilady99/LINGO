import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, MessageSquare, AlertCircle } from 'lucide-react';
import {
  ConnectionStatus,
  SUPPORTED_LANGUAGES,
  SCENARIOS,
  Language,
  PracticeScenario,
  TranscriptionEntry,
} from './types';

// Using lowercase because you said all file/folder names are lowercase:
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';

import Avatar from './components/avatar';
import TranscriptItem from './components/transcriptitem';
import AudioVisualizer from './components/audiovisualizer';

/** ---------- Error Boundary (prevents React minified crashes from blanking the app) ---------- */
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(err: any) {
    return { hasError: true, message: err?.message ? String(err.message) : 'Unknown error' };
  }

  componentDidCatch(err: any, info: any) {
    // Log full error for debugging in Vercel/Chrome console
    // (This is safe—no secrets printed)
    console.error('App crashed (ErrorBoundary):', err);
    console.error('Component stack:', info?.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full bg-slate-900/60 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
                <AlertCircle className="text-white" />
              </div>
              <div>
                <div className="text-lg font-black">App crashed (React Error)</div>
                <div className="text-xs text-slate-400">The UI component tree threw an error.</div>
              </div>
            </div>

            <div className="text-xs text-slate-300 bg-slate-950/60 border border-white/10 rounded-xl p-3 whitespace-pre-wrap break-words">
              {this.state.message}
            </div>

            <div className="mt-4 text-xs text-slate-400">
              Open DevTools → Console to see the full stack trace. This screen prevents a blank crash.
            </div>

            <button
              className="mt-6 bg-indigo-600 hover:bg-indigo-500 transition px-4 py-2 rounded-xl font-bold"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** ---------- Helpers ---------- */
function getViteApiKey(): string {
  const envAny = (import.meta as any)?.env || {};
  return (envAny.VITE_API_KEY as string) || (envAny.API_KEY as string) || '';
}

const AppInner: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptionEntry[]>([]);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) {
      try {
        activeSessionRef.current.close();
      } catch (e) {
        console.error('Error closing session:', e);
      }
      activeSessionRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {}
    });
    sourcesRef.current.clear();

    setStatus(ConnectionStatus.DISCONNECTED);
    setIsSpeaking(false);
    nextStartTimeRef.current = 0;
  }, []);

  useEffect(() => {
    return () => stopConversation();
  }, [stopConversation]);

  // ---- ENV DEBUG (visible on screen + console) ----
  const envMode = import.meta.env.MODE;
  const apiKeyForDisplay = getViteApiKey();
  const hasViteApiKey = Boolean(apiKeyForDisplay);
  const apiKeyLen = apiKeyForDisplay ? apiKeyForDisplay.length : 0;

  useEffect(() => {
    // do not print the key itself
    console.log('MODE:', envMode);
    console.log('Has VITE_API_KEY:', 'VITE_API_KEY' in import.meta.env);
    console.log('VITE_API_KEY length:', apiKeyLen);
  }, [envMode, apiKeyLen]);

  const startConversation = async () => {
    const apiKey = getViteApiKey();

    // do not print key value
    console.log('START clicked. MODE:', import.meta.env.MODE);
    console.log('Has VITE_API_KEY:', 'VITE_API_KEY' in import.meta.env);
    console.log('VITE_API_KEY length:', apiKey ? apiKey.length : 0);

    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Vercel Environment Variables (Production/Preview/Dev) and redeploy.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const ai = new GoogleGenAI({ apiKey });

      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const outputCtx = outputAudioContextRef.current!;
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);

      let systemInstruction = '';
      if ((selectedScenario as any).id === 'translator') {
        systemInstruction = `You are a professional real-time translator. Translate ${nativeLang.name} to ${targetLang.name} and vice versa. Speak ONLY the translation. Provide clear and natural speech.`;
      } else {
        systemInstruction = `You are a patient and friendly ${targetLang.name} tutor. User's native language is ${nativeLang.name}. Scenario: ${(selectedScenario as any).title}. Correct errors gently in the chat and keep the conversation flowing.`;
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);

            const inputCtx = inputAudioContextRef.current!;
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
              sessionPromise.then((s) => {
                if (!isMutedRef.current && s) {
                  s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
                }
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },

          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach((source) => {
                try {
                  source.stop();
                } catch {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (m.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += m.serverContent.inputTranscription.text;
            }
            if (m.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += m.serverContent.outputTranscription.text;
            }

            if (m.serverContent?.turnComplete) {
              const inText = currentInputTranscriptionRef.current;
              const outText = currentOutputTranscriptionRef.current;

              if (inText) {
                setTranscript((prev) => [...prev, { role: 'user', text: inText, timestamp: new Date() } as any]);
                currentInputTranscriptionRef.current = '';
              }
              if (outText) {
                setTranscript((prev) => [...prev, { role: 'model', text: outText, timestamp: new Date() } as any]);
                currentOutputTranscriptionRef.current = '';
              }
            }

            const parts = m.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const audioData = part.inlineData.data;
                setIsSpeaking(true);
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);

                const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
                const src = outputCtx.createBufferSource();
                src.buffer = buffer;
                src.connect(outputNode);

                src.onended = () => {
                  sourcesRef.current.delete(src);
                  if (sourcesRef.current.size === 0) setIsSpeaking(false);
                };

                src.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                sourcesRef.current.add(src);
              }
            }
          },

          onerror: (e) => {
            console.error('Session error:', e);
            setError('Connection lost. Please try again.');
            stopConversation();
          },

          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
          },
        },

        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });

      activeSessionRef.current = await sessionPromise;
    } catch (e) {
      console.error('Start conversation error:', e);
      setError('Microphone access denied or connection failed.');
      setStatus(ConnectionStatus.ERROR);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col md:flex-row text-slate-200 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-6 flex flex-col gap-6 z-20 overflow-y-auto">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <Headphones className="text-white" />
          </div>
          <h1 className="text-xl font-black">LingoLive</h1>
        </div>

        {/* ENV status (visible) */}
        <div className="bg-slate-800/40 rounded-2xl border border-white/5 p-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Env</div>
          <div className="mt-1 text-xs text-slate-300">
            MODE: <span className="font-bold text-slate-100">{envMode}</span>
          </div>
          <div className="text-xs text-slate-300">
            VITE_API_KEY:{" "}
            <span className={`font-bold ${hasViteApiKey ? 'text-green-400' : 'text-red-400'}`}>
              {hasViteApiKey ? `present (len ${apiKeyLen})` : 'missing'}
            </span>
          </div>
          <div className="text-[10px] text-slate-500 mt-1">If missing: set VITE_API_KEY in Vercel → Env Vars and redeploy.</div>
        </div>

        <div className="space-y-4 mt-4">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Language Settings</label>
          <div className="p-3 bg-slate-800/40 rounded-2xl border border-white/5 space-y-3">
            <div className="space-y-1">
              <span className="text-[10px] text-slate-400 block ml-1">Learn</span>
              <select
                value={targetLang.code}
                onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) as Language)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <span className="text-[10px] text-slate-400 block ml-1">Native</span>
              <select
                value={nativeLang.code}
                onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) as Language)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Training Mode</label>
          <div className="space-y-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedScenario(s)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                  selectedScenario.id === s.id
                    ? 'bg-indigo-600/20 border-indigo-500'
                    : 'bg-slate-800/40 border-transparent hover:bg-slate-800'
                }`}
              >
                <span className="text-xl">{(s as any).icon}</span>
                <div>
                  <div className="font-bold text-xs">{(s as any).title}</div>
                  <div className="text-[9px] text-slate-500">{(s as any).description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col mt-4 min-h-0">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
            <MessageSquare size={12} /> Live Transcript
          </label>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto space-y-1 pr-2 scroll-smooth scrollbar-thin scrollbar-thumb-slate-700"
          >
            {transcript.length === 0 ? (
              <div className="text-[10px] text-slate-600 italic mt-4 text-center">Your conversation will appear here...</div>
            ) : (
              transcript.map((entry, i) => <TranscriptItem key={i} entry={entry} />)
            )}
          </div>
        </div>
      </aside>

      {/* Main Experience */}
      <main className="flex-1 flex flex-col items-center justify-center p-8 relative">
        <div className="absolute top-8 right-8 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
          <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} />
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
          <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-10 text-center w-full max-w-xl">
          <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
          <div className="space-y-2">
            <h2 className="text-4xl font-black text-white tracking-tight">
              {status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'Gemini is speaking' : 'Listening...') : (selectedScenario as any).title}
            </h2>
            <p className="text-slate-500 text-sm max-w-md mx-auto">{(selectedScenario as any).description}</p>
          </div>

          {(isSpeaking || (status === ConnectionStatus.CONNECTED && !isMuted)) && (
            <div className="h-12 flex items-center justify-center">
              <AudioVisualizer isActive={true} />
            </div>
          )}
        </div>

        <div className="w-full max-w-md flex flex-col items-center gap-8 py-10">
          {error && (
            <div className="text-red-400 text-xs font-bold bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20 flex items-center gap-2">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <div className="flex items-center gap-6">
            {status === ConnectionStatus.CONNECTED ? (
              <>
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
                  className={`p-6 rounded-full border-2 transition-all shadow-2xl ${
                    isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 hover:border-indigo-500'
                  }`}
                >
                  {isMuted ? <MicOff /> : <Mic />}
                </button>

                <button
                  onClick={stopConversation}
                  className="bg-red-600 px-12 py-6 rounded-2xl font-black flex items-center gap-3 hover:bg-red-700 transition-colors shadow-2xl shadow-red-900/20"
                >
                  <LogOut /> EXIT
                </button>
              </>
            ) : (
              <button
                onClick={startConversation}
                disabled={status === ConnectionStatus.CONNECTING}
                className="bg-indigo-600 px-24 py-8 rounded-3xl font-black flex items-center gap-4 text-xl shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Mic size={32} /> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START'}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
};

export default App;

