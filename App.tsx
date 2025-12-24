import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  X,
  Accessibility,
  Minus,
  Plus,
  Contrast,
} from 'lucide-react';

import { ConnectionStatus } from './types';

// keep your lowercase paths
import { createPcmBlob, decodeAudioData } from './services/audioservice';

// keep your lowercase component paths
import Avatar from './components/avatar';
import AudioVisualizer from './components/audiovisualizer';

type Language = { code: string; name: string; flag: string };

type PracticeScenario = {
  id: 'translator' | 'chat' | 'expert';
  title: string;
  description: string;
  icon: string;
};

// ✅ FIX: use a Live model that exists / supported
const MODEL_NAME = 'gemini-1.5-flash-live';

// ✅ Contact
const CONTACT_EMAIL = 'callilcoil@gmail.com';

// ✅ Settings storage
type A11yPrefs = {
  fontScale: 1 | 1.15 | 1.3;
  highContrast: boolean;
  reduceMotion: boolean;
  focusRing: boolean;
};
const A11Y_STORAGE_KEY = 'lingolive_a11y_v1';

const SCENARIOS: PracticeScenario[] = [
  {
    id: 'translator',
    title: 'Real-time Translator',
    description: 'Bi-directional translation between 2 languages.',
    icon: '🌐',
  },
  {
    id: 'chat',
    title: 'Casual Chat',
    description: 'Friendly conversation to build fluency.',
    icon: '💬',
  },
  {
    id: 'expert',
    title: 'Expert Tutor',
    description: 'Intensive practice with corrections.',
    icon: '🎯',
  },
];

// ✅ Requested languages, sorted ABC by name (deduped)
const SUPPORTED_LANGUAGES: Language[] = [
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
].sort((a, b) => a.name.localeCompare(b.name));

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find((l) => l.code === 'en') || SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => SUPPORTED_LANGUAGES.find((l) => l.code === 'he') || SUPPORTED_LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);

  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [a11y, setA11y] = useState<A11yPrefs>({
    fontScale: 1,
    highContrast: false,
    reduceMotion: false,
    focusRing: true,
  });

  // audio/session refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Load a11y
  useEffect(() => {
    try {
      const saved = localStorage.getItem(A11Y_STORAGE_KEY);
      if (saved) setA11y(JSON.parse(saved));
    } catch {}
  }, []);

  // Save a11y
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

  const stopConversation = useCallback(() => {
    // close live session
    if (activeSessionRef.current) {
      try {
        activeSessionRef.current.close();
      } catch {}
      activeSessionRef.current = null;
    }

    // stop mic
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    // stop queued audio
    sourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    sourcesRef.current.clear();

    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  useEffect(() => {
    return () => stopConversation();
  }, [stopConversation]);

  const buildSystemInstruction = useCallback(() => {
    if (selectedScenario.id === 'translator') {
      return `You are a professional real-time translator. Translate ${nativeLang.name} to ${targetLang.name} and vice versa. Speak ONLY the translation. Provide clear and natural speech.`;
    }
    if (selectedScenario.id === 'expert') {
      return `You are an expert ${targetLang.name} tutor. The user's native language is ${nativeLang.name}. Be direct, correct mistakes clearly, and guide the user with short, practical prompts.`;
    }
    return `You are a patient and friendly ${targetLang.name} tutor. The user's native language is ${nativeLang.name}. Keep the conversation flowing with short, natural prompts and gentle corrections.`;
  }, [nativeLang.name, selectedScenario.id, targetLang.name]);

  const startConversation = useCallback(async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY || (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const ai = new GoogleGenAI({ apiKey });

      // audio contexts
      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const outCtx = outputAudioContextRef.current!;
      const outGain = outCtx.createGain();
      outGain.connect(outCtx.destination);

      const systemInstruction = buildSystemInstruction();

      // IMPORTANT: create the session first
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          // keep simple; server decides best audio format
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);

            const inCtx = inputAudioContextRef.current!;
            const source = inCtx.createMediaStreamSource(stream);

            // ScriptProcessor is old but works widely
            const proc = inCtx.createScriptProcessor(4096, 1, 1);

            proc.onaudioprocess = (e) => {
              sessionPromise.then((s) => {
                if (!s) return;
                if (isMutedRef.current) return;
                try {
                  s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
                } catch {}
              });
            };

            source.connect(proc);
            proc.connect(inCtx.destination);
          },

          onmessage: async (m: LiveServerMessage) => {
            // interruption: stop queued audio immediately
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach((src) => {
                try {
                  src.stop();
                } catch {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            // audio from model
            const parts = m.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                try {
                  setIsSpeaking(true);
                  const audioBytes = part.inlineData.data;
                  const audioBuffer = await decodeAudioData(outputAudioContextRef.current!, audioBytes);

                  const src = outputAudioContextRef.current!.createBufferSource();
                  src.buffer = audioBuffer;
                  src.connect(outGain);

                  const startAt = Math.max(outputAudioContextRef.current!.currentTime, nextStartTimeRef.current);
                  src.start(startAt);
                  nextStartTimeRef.current = startAt + audioBuffer.duration;

                  sourcesRef.current.add(src);
                  src.onended = () => {
                    sourcesRef.current.delete(src);
                    if (sourcesRef.current.size === 0) setIsSpeaking(false);
                  };
                } catch {}
              }
            }

            if (m.serverContent?.turnComplete) {
              // when turn ends and no more sources, drop speaking
              if (sourcesRef.current.size === 0) setIsSpeaking(false);
            }
          },

          onerror: (e: any) => {
            console.error('Live error', e);
            setError('Audio/session error. Please refresh and try again.');
            setStatus(ConnectionStatus.ERROR);
            stopConversation();
          },

          onclose: (e: any) => {
            // show server reason when possible
            const reason = e?.reason ? String(e.reason) : '';
            const code = e?.code ? String(e.code) : '';
            const msg = reason ? `Closed: ${reason}${code ? ` (code ${code})` : ''}` : 'Server closed the session.';
            setError(msg);
            stopConversation();
          },
        },
      });

      // store session
      const s = await sessionPromise;
      activeSessionRef.current = s;
    } catch (e: any) {
      console.error(e);
      setError('Failed to start session. Check mic permissions and try again.');
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [buildSystemInstruction, stopConversation]);

  const fontScaleStyle: React.CSSProperties = useMemo(
    () => ({ fontSize: `${a11y.fontScale * 100}%` }),
    [a11y.fontScale]
  );

  const rootClasses = useMemo(() => {
    return [
      'h-dvh',
      'w-dvw',
      'bg-slate-950',
      'text-slate-200',
      'overflow-hidden',
      a11y.highContrast ? 'contrast-125 saturate-125' : '',
      a11y.focusRing ? '' : 'focus:outline-none',
    ]
      .filter(Boolean)
      .join(' ');
  }, [a11y.focusRing, a11y.highContrast]);

  const incFont = () => setA11y((p) => ({ ...p, fontScale: p.fontScale === 1 ? 1.15 : p.fontScale === 1.15 ? 1.3 : 1.3 }));
  const decFont = () => setA11y((p) => ({ ...p, fontScale: p.fontScale === 1.3 ? 1.15 : p.fontScale === 1.15 ? 1 : 1 }));

  return (
    <div className={rootClasses} style={fontScaleStyle}>
      <div className="h-full w-full flex flex-col md:flex-row overflow-hidden">
        {/* LEFT PANEL */}
        <aside className="w-full md:w-80 bg-slate-900 border-r border-white/5 p-4 md:p-6 flex flex-col gap-4 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shrink-0">
                <Headphones className="text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-lg font-black leading-tight truncate">LingoLive</div>
                <div className="text-[10px] text-slate-500 truncate">language practice & live translation</div>
              </div>
            </div>

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
              aria-label="Open settings"
              title="Settings"
            >
              <Settings size={18} />
            </button>
          </div>

          {/* Mobile: Languages + Mode side-by-side, so avatar & start remain visible */}
          <div className="grid grid-cols-2 gap-3">
            {/* Languages */}
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>

              <div className="space-y-2">
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-400 block ml-1">Learn</span>
                  <select
                    value={targetLang.code}
                    onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) || SUPPORTED_LANGUAGES[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
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
                    onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) || SUPPORTED_LANGUAGES[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
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

            {/* Modes */}
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mode</div>

              <div className="space-y-2">
                {SCENARIOS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedScenario(s)}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className={`w-full flex items-start gap-2 p-3 rounded-xl border text-left transition-all ${
                      selectedScenario.id === s.id
                        ? 'bg-indigo-600/20 border-indigo-500'
                        : 'bg-slate-800/40 border-transparent hover:bg-slate-800'
                    }`}
                    aria-label={`Select mode ${s.title}`}
                  >
                    <span className="text-lg leading-none">{s.icon}</span>
                    <div className="min-w-0">
                      <div className="font-black text-xs truncate">{s.title}</div>
                      <div className="text-[10px] text-slate-500 leading-snug line-clamp-2">{s.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Footer on left (moved down so it won't cover the START on mobile) */}
          <div className="mt-auto pt-2 flex items-center justify-between text-[10px] text-slate-500">
            <div>© 2025 LingoLive</div>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
              aria-label="Open settings (footer)"
              title="Settings"
            >
              <Settings size={14} />
            </button>
          </div>
        </aside>

        {/* MAIN */}
        <main className="flex-1 h-full overflow-hidden flex flex-col">
          <div className="relative flex-1 overflow-hidden flex items-center justify-center p-6 md:p-10">
            {/* Status pill */}
            <div className="absolute top-4 md:top-6 right-4 md:right-6 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
              <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
              <div
                className={`w-2 h-2 rounded-full ${
                  status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'
                }`}
              />
              <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
            </div>

            <div className="w-full max-w-2xl flex flex-col items-center justify-center gap-5 text-center">
              {/* START always on top */}
              <div className="w-full flex items-center justify-center">
                {status === ConnectionStatus.CONNECTED ? (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setIsMuted((v) => !v)}
                      className={`px-5 py-3 rounded-2xl font-black border transition-all ${
                        isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 hover:border-indigo-500'
                      }`}
                      aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      <span className="inline-flex items-center gap-2">{isMuted ? <MicOff size={18} /> : <Mic size={18} />} MIC</span>
                    </button>

                    <button
                      onClick={stopConversation}
                      className="px-6 py-3 rounded-2xl font-black bg-red-600 hover:bg-red-700 transition-colors shadow-2xl shadow-red-900/20 inline-flex items-center gap-2"
                      aria-label="Stop"
                    >
                      <LogOut size={18} /> STOP
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startConversation}
                    disabled={status === ConnectionStatus.CONNECTING}
                    className="w-full md:w-[520px] bg-indigo-600 px-8 py-4 rounded-3xl font-black flex items-center justify-center gap-3 text-base md:text-lg shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Start live session"
                  >
                    <Mic size={22} />
                    {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                  </button>
                )}
              </div>

              {/* Avatar ~20% smaller */}
              <div className="scale-[0.8] md:scale-[0.85] origin-top">
                <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
              </div>

              <div className="space-y-2 -mt-2">
                <h2 className="text-3xl md:text-4xl font-black text-white tracking-tight">
                  {status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'Gemini is speaking' : 'Listening...') : selectedScenario.title}
                </h2>
                <p className="text-slate-500 text-sm max-w-md mx-auto">{selectedScenario.description}</p>
              </div>

              {/* Error */}
              {error && (
                <div className="w-full max-w-xl text-red-300 text-xs font-bold bg-red-400/10 px-4 py-3 rounded-xl border border-red-400/20 flex items-center gap-2">
                  <AlertCircle size={16} />
                  <span className="break-words">{error}</span>
                </div>
              )}

              {/* Footer links (kept simple) */}
              <div className="pt-2 text-[11px] text-slate-500 flex items-center gap-4">
                <a href="/privacy" className="hover:text-slate-300">Privacy</a>
                <a href="/terms" className="hover:text-slate-300">Terms</a>
                <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-300">Contact</a>
              </div>
            </div>
          </div>
        </main>
      </div>

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
                    href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`}
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Contact
                  </a>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-black text-xs"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
