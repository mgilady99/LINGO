import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
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

// keep your repo casing:
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
const CONTACT_EMAIL = 'callilcoil@gmail.com';

type PageView = 'main' | 'privacy' | 'terms';

function detectPage(): PageView {
  const p = window.location.pathname.toLowerCase();
  if (p.startsWith('/privacy')) return 'privacy';
  if (p.startsWith('/terms')) return 'terms';
  return 'main';
}

const App: React.FC = () => {
  const [page, setPage] = useState<PageView>(() => detectPage());

  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptionEntry[]>([]);

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

  // stale closure fix
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // SPA-like nav for /privacy /terms (Cloudflare Pages)
  useEffect(() => {
    const onPop = () => setPage(detectPage());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (path: '/privacy' | '/terms' | '/') => {
    window.history.pushState({}, '', path);
    setPage(detectPage());
    // scroll to top within app
  };

  // Load a11y prefs
  useEffect(() => {
    try {
      const saved = localStorage.getItem(A11Y_STORAGE_KEY);
      if (saved) setA11y(JSON.parse(saved));
    } catch {}
  }, []);
  // Save a11y prefs
  useEffect(() => {
    try {
      localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(a11y));
    } catch {}
  }, [a11y]);

  // Reduce motion
  useEffect(() => {
    if (a11y.reduceMotion) document.documentElement.classList.add('motion-reduce');
    else document.documentElement.classList.remove('motion-reduce');
  }, [a11y.reduceMotion]);

  // ESC closes settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSettingsOpen(false);
    };
    if (isSettingsOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSettingsOpen]);

  // Auto-scroll transcript box only
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript]);

  const stopConversation = useCallback(() => {
    if (activeSessionRef.current) {
      try {
        activeSessionRef.current.close();
      } catch {}
      activeSessionRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    sourcesRef.current.forEach((s) => {
      try {
        s.stop();
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
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Cloudflare Pages → Settings → Variables.');
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

                try {
                  const pcm = decode(audioData);
                  const audioBuffer = await decodeAudioData(outputCtx, pcm, 24000);

                  const source = outputCtx.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(outputNode);

                  const now = outputCtx.currentTime;
                  const startTime = Math.max(now, nextStartTimeRef.current);
                  source.start(startTime);

                  sourcesRef.current.add(source);
                  source.onended = () => sourcesRef.current.delete(source);

                  nextStartTimeRef.current = startTime + audioBuffer.duration;

                  setIsSpeaking(true);
                  window.setTimeout(() => {
                    if (outputCtx.currentTime >= nextStartTimeRef.current - 0.05) setIsSpeaking(false);
                  }, Math.max(50, audioBuffer.duration * 1000));
                } catch (e) {
                  console.error('Audio decode/play error', e);
                }
              }
            }
          },

          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            setIsSpeaking(false);
          },

          onerror: (e: any) => {
            console.error('Session error:', e);
            setError('Connection error. Please try again.');
            setStatus(ConnectionStatus.ERROR);
            stopConversation();
          },
        },
        config: {
          systemInstruction,
          generationConfig: {
            responseModalities: ['AUDIO'],
          } as any,
        },
      });

      const session = await sessionPromise;
      activeSessionRef.current = session;
    } catch (e: any) {
      console.error(e);
      setError(e?.message || 'Failed to start session');
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  };

  const fontScaleStyle: React.CSSProperties = useMemo(
    () => ({ fontSize: `${a11y.fontScale * 100}%` }),
    [a11y.fontScale]
  );

  const rootClasses = useMemo(() => {
    return [
      'h-dvh w-dvw overflow-hidden',
      'bg-slate-950 text-slate-200',
      'flex flex-col md:flex-row',
      a11y.highContrast ? 'contrast-125 saturate-125' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }, [a11y.highContrast]);

  const incFont = () => {
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1 ? 1.15 : p.fontScale === 1.15 ? 1.3 : 1.3 }));
  };
  const decFont = () => {
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1.3 ? 1.15 : p.fontScale === 1.15 ? 1 : 1 }));
  };

  const ScenarioBar = () => (
    <div className="flex gap-2 w-full">
      {SCENARIOS.map((s) => {
        const active = (selectedScenario as any).id === (s as any).id;
        return (
          <button
            key={(s as any).id}
            onClick={() => setSelectedScenario(s)}
            disabled={status !== ConnectionStatus.DISCONNECTED}
            className={[
              'flex-1',
              'px-3 py-3 rounded-xl',
              'border text-left transition',
              active ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-900/40 border-white/10 hover:bg-slate-800/60',
            ].join(' ')}
            aria-label={`Select mode ${(s as any).title}`}
          >
            <div className="text-[11px] font-black leading-4">{(s as any).title}</div>
            <div className="text-[10px] text-slate-500 leading-4 line-clamp-1">{(s as any).description}</div>
          </button>
        );
      })}
    </div>
  );

  const RightFooter = () => (
    <div className="w-full flex items-center justify-between gap-3 px-4 py-3 border-t border-white/5 bg-slate-950/40">
      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        <button
          onClick={() => go('/privacy')}
          className="hover:text-slate-200 transition"
          aria-label="Privacy"
        >
          Privacy
        </button>
        <span className="opacity-40">•</span>
        <button
          onClick={() => go('/terms')}
          className="hover:text-slate-200 transition"
          aria-label="Terms"
        >
          Terms
        </button>
        <span className="opacity-40">•</span>
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`}
          className="hover:text-slate-200 transition"
          aria-label="Contact"
        >
          Contact
        </a>
      </div>

      {/* SETTINGS moved to bottom-right next to contact */}
      <button
        onClick={() => setIsSettingsOpen(true)}
        className="p-2 rounded-xl border border-white/10 bg-slate-900/40 hover:bg-slate-800/60 transition"
        aria-label="Open settings"
        title="Settings"
      >
        <Settings size={18} />
      </button>
    </div>
  );

  const LeftFooter = () => (
    <div className="mt-auto pt-4 border-t border-white/5 text-[11px] text-slate-500 flex items-center gap-2 justify-between">
      <span>© 2025 LingoLive</span>
      <span className="inline-flex items-center gap-1 opacity-80">
        <Headphones size={14} /> LINGOLIVE
      </span>
    </div>
  );

  // --- Privacy / Terms simple pages (no extra files needed)
  if (page === 'privacy') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black">Privacy Policy</h1>
            <button
              onClick={() => go('/')}
              className="px-4 py-2 rounded-xl bg-slate-900 border border-white/10 hover:bg-slate-800"
            >
              Back
            </button>
          </div>
          <div className="text-sm text-slate-300 space-y-3">
            <p>
              LingoLive is a language practice app. We do not sell personal data.
            </p>
            <p>
              Voice audio is used only to provide the live session functionality. Your settings (like accessibility preferences)
              may be stored locally in your browser.
            </p>
            <p>
              Contact: <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (page === 'terms') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black">Terms of Service</h1>
            <button
              onClick={() => go('/')}
              className="px-4 py-2 rounded-xl bg-slate-900 border border-white/10 hover:bg-slate-800"
            >
              Back
            </button>
          </div>
          <div className="text-sm text-slate-300 space-y-3">
            <p>
              By using LingoLive you agree to use it responsibly and comply with local laws.
            </p>
            <p>
              Service is provided “as is” with no warranties. You are responsible for your own usage and any content you generate.
            </p>
            <p>
              Contact: <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --- MAIN APP UI
  return (
    <div className={rootClasses} style={fontScaleStyle}>
      {/* LEFT PANEL */}
      <aside className="w-full md:w-96 shrink-0 h-full bg-slate-900 border-r border-white/5 p-4 md:p-6 flex flex-col gap-5 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <Headphones className="text-white" />
          </div>
          <div className="flex-1">
            <div className="text-xl font-black leading-5">LingoLive</div>
            <div className="text-[11px] text-slate-500">Language practice & live translation</div>
          </div>
        </div>

        {/* TOP GRID: Languages (33%) + Modes (67%) */}
        <div className="w-full flex gap-3 items-stretch">
          {/* Languages: 33% */}
          <div className="w-1/3 min-w-[150px] space-y-2">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>

            <div className="space-y-2">
              <div className="space-y-1">
                <div className="text-[10px] text-slate-400">Learn</div>
                <select
                  value={targetLang.code}
                  onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
                  disabled={status !== ConnectionStatus.DISCONNECTED}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-[11px] focus:ring-2 focus:ring-indigo-500 outline-none"
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
                <div className="text-[10px] text-slate-400">Native</div>
                <select
                  value={nativeLang.code}
                  onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
                  disabled={status !== ConnectionStatus.DISCONNECTED}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-[11px] focus:ring-2 focus:ring-indigo-500 outline-none"
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

          {/* Modes: remaining space */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mode</div>
            {/* In mobile it still fits (3 buttons in a row); if too tight, they wrap */}
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map((s) => {
                const active = (selectedScenario as any).id === (s as any).id;
                return (
                  <button
                    key={(s as any).id}
                    onClick={() => setSelectedScenario(s)}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className={[
                      'flex-1 min-w-[140px]',
                      'px-3 py-3 rounded-xl border text-left transition',
                      active ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-900/40 border-white/10 hover:bg-slate-800/60',
                    ].join(' ')}
                    aria-label={`Select mode ${(s as any).title}`}
                  >
                    <div className="text-[11px] font-black leading-4">{(s as any).title}</div>
                    <div className="text-[10px] text-slate-500 leading-4 line-clamp-1">{(s as any).description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Transcript */}
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              <MessageSquare size={12} /> Live Transcript
            </label>
            <span className="text-[10px] text-slate-600">{transcript.length ? `${transcript.length}` : ''}</span>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-2 scroll-smooth scrollbar-thin scrollbar-thumb-slate-700"
            aria-label="Live transcript"
          >
            {transcript.length === 0 ? (
              <div className="text-[10px] text-slate-600 italic mt-4 text-center">
                Your conversation will appear here...
              </div>
            ) : (
              transcript.map((entry, i) => <TranscriptItem key={i} entry={entry} />)
            )}
          </div>
        </div>

        {/* Left footer: "2025 LINGOLIVE" line */}
        <LeftFooter />
      </aside>

      {/* RIGHT / MAIN */}
      <main className="flex-1 h-full overflow-hidden flex flex-col">
        {/* Top status pill */}
        <div className="p-4 md:p-6">
          <div className="ml-auto w-fit flex items-center gap-3 bg-slate-900/70 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
            <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
            <div
              className={[
                'w-2 h-2 rounded-full',
                status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700',
              ].join(' ')}
            />
            <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
          </div>
        </div>

        {/* Center content: Always visible avatar on mobile */}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-4 md:px-10 pb-2 overflow-hidden">
          <div className="w-full max-w-2xl flex flex-col items-center justify-center gap-5 md:gap-6 text-center">
            {/* START button must be ABOVE avatar */}
            {status === ConnectionStatus.CONNECTED ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsMuted((v) => !v)}
                  title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
                  className={[
                    'p-4 rounded-2xl border transition shadow-xl',
                    isMuted ? 'bg-red-500/80 border-red-400' : 'bg-slate-900/40 border-white/10 hover:bg-slate-800/60',
                  ].join(' ')}
                  aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {isMuted ? <MicOff /> : <Mic />}
                </button>

                <button
                  onClick={stopConversation}
                  className="bg-red-600 px-8 py-4 rounded-2xl font-black flex items-center gap-3 hover:bg-red-700 transition-colors shadow-2xl shadow-red-900/20"
                  aria-label="Exit"
                >
                  <LogOut /> EXIT
                </button>
              </div>
            ) : (
              <button
                onClick={startConversation}
                disabled={status === ConnectionStatus.CONNECTING}
                className="bg-indigo-600 px-10 md:px-14 py-4 md:py-5 rounded-2xl font-black flex items-center gap-3 text-base md:text-lg shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Start live session"
              >
                <Mic size={22} /> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
              </button>
            )}

            {/* Avatar 20% smaller */}
            <div className="scale-[0.8] md:scale-[0.8] origin-top">
              <Avatar
                state={
                  status !== ConnectionStatus.CONNECTED
                    ? 'idle'
                    : isSpeaking
                    ? 'speaking'
                    : isMuted
                    ? 'thinking'
                    : 'listening'
                }
              />
            </div>

            <div className="space-y-2 -mt-2">
              <h2 className="text-2xl md:text-4xl font-black text-white tracking-tight">
                {status === ConnectionStatus.CONNECTED
                  ? isSpeaking
                    ? 'Gemini is speaking'
                    : 'Listening...'
                  : (selectedScenario as any).title}
              </h2>
              <p className="text-slate-500 text-sm max-w-md mx-auto">
                {(selectedScenario as any).description}
              </p>
            </div>

            {(isSpeaking || (status === ConnectionStatus.CONNECTED && !isMuted)) && (
              <div className="h-10 flex items-center justify-center">
                <AudioVisualizer isActive={true} color={isSpeaking ? '#6366f1' : '#10b981'} />
              </div>
            )}

            {error && (
              <div className="text-red-400 text-xs font-bold bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20 flex items-center gap-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}
          </div>
        </div>

        {/* Bottom footer (right side): links + SETTINGS icon moved here */}
        <RightFooter />
      </main>

      {/* SETTINGS MODAL */}
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
                  <button
                    onClick={() => {
                      setIsSettingsOpen(false);
                      go('/privacy');
                    }}
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Privacy
                  </button>

                  <button
                    onClick={() => {
                      setIsSettingsOpen(false);
                      go('/terms');
                    }}
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Terms
                  </button>

                  <a
                    href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`}
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Contact
                  </a>
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
