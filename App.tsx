import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  MessageSquare,
  AlertCircle,
  Settings,
  X,
  Accessibility,
  Minus,
  Plus,
  Contrast,
  MousePointer2,
} from 'lucide-react';
import {
  ConnectionStatus,
  SUPPORTED_LANGUAGES,
  SCENARIOS,
  Language,
  PracticeScenario,
  TranscriptionEntry,
} from './types';

import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';

import Avatar from './components/avatar';
import TranscriptItem from './components/transcriptitem';
import AudioVisualizer from './components/audiovisualizer';

type A11yPrefs = {
  fontScale: 1 | 1.15 | 1.3;
  highContrast: boolean;
  reduceMotion: boolean;
  focusRing: boolean;
};

const A11Y_STORAGE_KEY = 'lingolive_a11y_v1';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptionEntry[]>([]);

  // Settings + Accessibility
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [a11y, setA11y] = useState<A11yPrefs>({
    fontScale: 1,
    highContrast: false,
    reduceMotion: false,
    focusRing: true,
  });

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

  // Load accessibility prefs
  useEffect(() => {
    try {
      const saved = localStorage.getItem(A11Y_STORAGE_KEY);
      if (saved) setA11y(JSON.parse(saved));
    } catch {}
  }, []);

  // Save accessibility prefs
  useEffect(() => {
    try {
      localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(a11y));
    } catch {}
  }, [a11y]);

  // Apply reduce motion to document (nice touch for animations)
  useEffect(() => {
    if (a11y.reduceMotion) {
      document.documentElement.classList.add('motion-reduce');
    } else {
      document.documentElement.classList.remove('motion-reduce');
    }
  }, [a11y.reduceMotion]);

  // ESC closes settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSettingsOpen(false);
    };
    if (isSettingsOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSettingsOpen]);

  // Auto-scroll transcript (only transcript area)
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

  const startConversation = async () => {
    // Vite: only VITE_* env vars are exposed to the client bundle
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Environment Variables and redeploy.');
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

      const outputCtx = outputAudioContextRef.current;
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
              if (currentInputTranscriptionRef.current) {
                setTranscript((prev) => [
                  ...prev,
                  { role: 'user', text: currentInputTranscriptionRef.current, timestamp: new Date() } as any,
                ]);
                currentInputTranscriptionRef.current = '';
              }
              if (currentOutputTranscriptionRef.current) {
                setTranscript((prev) => [
                  ...prev,
                  { role: 'model', text: currentOutputTranscriptionRef.current, timestamp: new Date() } as any,
                ]);
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

  const fontScaleStyle: React.CSSProperties = {
    fontSize: `${a11y.fontScale * 100}%`,
  };

  const rootClasses = [
    'min-h-screen',
    'bg-slate-950',
    'flex',
    'flex-col',
    'md:flex-row',
    'text-slate-200',
    'overflow-hidden',
    a11y.highContrast ? 'contrast-125 saturate-125' : '',
    a11y.focusRing ? '' : 'focus:outline-none',
  ]
    .filter(Boolean)
    .join(' ');

  const incFont = () => {
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1 ? 1.15 : p.fontScale === 1.15 ? 1.3 : 1.3 }));
  };
  const decFont = () => {
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1.3 ? 1.15 : p.fontScale === 1.15 ? 1 : 1 }));
  };

  return (
    <div className={rootClasses} style={fontScaleStyle}>
      {/* Sidebar */}
      <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-6 flex flex-col gap-6 z-20 overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
              <Headphones className="text-white" />
            </div>
            <h1 className="text-xl font-black">LingoLive</h1>
          </div>

          {/* Settings button */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
            aria-label="Open settings"
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Language Settings</label>
          <div className="p-3 bg-slate-800/40 rounded-2xl border border-white/5 space-y-3">
            <div className="space-y-1">
              <span className="text-[10px] text-slate-400 block ml-1">Learn</span>
              <select
                value={targetLang.code}
                onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                aria-label="Select learning language"
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
                onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                aria-label="Select native language"
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
                key={(s as any).id}
                onClick={() => setSelectedScenario(s)}
                disabled={status !== ConnectionStatus.DISCONNECTED}
                className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                  (selectedScenario as any).id === (s as any).id
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

          {/* IMPORTANT: only this area scrolls */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto space-y-1 pr-2 scroll-smooth scrollbar-thin scrollbar-thumb-slate-700"
            aria-label="Live transcript"
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
      <main className="flex-1 flex flex-col items-center justify-center p-8 relative overflow-hidden">
        <div className="absolute top-8 right-8 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
          <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
          <div
            className={`w-2 h-2 rounded-full ${
              status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'
            }`}
          />
          <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-10 text-center w-full max-w-xl">
          <Avatar
            state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'}
          />

          <div className="space-y-2">
            <h2 className="text-4xl font-black text-white tracking-tight">
              {status === ConnectionStatus.CONNECTED
                ? isSpeaking
                  ? 'Gemini is speaking'
                  : 'Listening...'
                : (selectedScenario as any).title}
            </h2>
            <p className="text-slate-500 text-sm max-w-md mx-auto">{(selectedScenario as any).description}</p>
          </div>

          {(isSpeaking || (status === ConnectionStatus.CONNECTED && !isMuted)) && (
            <div className="h-12 flex items-center justify-center">
              <AudioVisualizer isActive={true} color={isSpeaking ? '#6366f1' : '#10b981'} />
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
                  aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {isMuted ? <MicOff /> : <Mic />}
                </button>

                <button
                  onClick={stopConversation}
                  className="bg-red-600 px-12 py-6 rounded-2xl font-black flex items-center gap-3 hover:bg-red-700 transition-colors shadow-2xl shadow-red-900/20"
                  aria-label="Exit"
                >
                  <LogOut /> EXIT
                </button>
              </>
            ) : (
              <button
                onClick={startConversation}
                disabled={status === ConnectionStatus.CONNECTING}
                className="bg-indigo-600 px-24 py-8 rounded-3xl font-black flex items-center gap-4 text-xl shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Start"
              >
                <Mic size={32} /> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START'}
              </button>
            )}
          </div>
        </div>
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-slate-950 border border-white/10 rounded-2xl shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Accessibility />
                <h3 className="text-lg font-black">Settings</h3>
              </div>
              <button
                className="p-2 rounded-xl hover:bg-white/5 border border-white/10"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-slate-900/60 border border-white/10">
                <div className="flex items-center gap-2 mb-3">
                  <MousePointer2 size={16} />
                  <div className="font-black text-sm">Accessibility</div>
                </div>

                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-xs text-slate-300">Text size</div>
                  <div className="flex items-center gap-2">
                    <button
                      className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
                      onClick={decFont}
                      aria-label="Decrease text size"
                    >
                      <Minus size={16} />
                    </button>
                    <div className="text-xs font-black w-16 text-center">
                      {a11y.fontScale === 1 ? '100%' : a11y.fontScale === 1.15 ? '115%' : '130%'}
                    </div>
                    <button
                      className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
                      onClick={incFont}
                      aria-label="Increase text size"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300 flex items-center gap-2">
                    <Contrast size={16} /> High contrast
                  </span>
                  <input
                    type="checkbox"
                    checked={a11y.highContrast}
                    onChange={(e) => setA11y((p) => ({ ...p, highContrast: e.target.checked }))}
                    className="h-4 w-4"
                    aria-label="Toggle high contrast"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300">Reduce motion</span>
                  <input
                    type="checkbox"
                    checked={a11y.reduceMotion}
                    onChange={(e) => setA11y((p) => ({ ...p, reduceMotion: e.target.checked }))}
                    className="h-4 w-4"
                    aria-label="Toggle reduce motion"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300">Show focus outline</span>
                  <input
                    type="checkbox"
                    checked={a11y.focusRing}
                    onChange={(e) => setA11y((p) => ({ ...p, focusRing: e.target.checked }))}
                    className="h-4 w-4"
                    aria-label="Toggle focus outline"
                  />
                </label>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900/60 border border-white/10">
                <div className="font-black text-sm mb-2">Links</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <a
                    href="/privacy"
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Privacy
                  </a>
                  <a
                    href="/terms"
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Terms
                  </a>
                  <a
                    href="mailto:callilcoil@gmail.com?subject=LingoLive%20Contact"
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Contact
                  </a>
                </div>

                <div className="text-[10px] text-slate-500 mt-3">
                  Tip: if you don’t have /privacy and /terms pages yet, they may show 404. We can add them next.
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-black text-xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;


