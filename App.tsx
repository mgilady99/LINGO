import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  Accessibility,
  X,
  Minus,
  Plus,
  Contrast,
} from 'lucide-react';

import { ConnectionStatus, SCENARIOS, Language, PracticeScenario, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';
import Avatar from './components/avatar';
import AudioVisualizer from './components/audiovisualizer';

type PageView = 'main' | 'privacy' | 'terms';

type A11yPrefs = {
  fontScale: 1 | 1.15 | 1.3;
  highContrast: boolean;
  reduceMotion: boolean;
  focusRing: boolean;
};
const A11Y_STORAGE_KEY = 'lingolive_a11y_v1';
const CONTACT_EMAIL = 'callilcoil@gmail.com';

// שפות לפי ABC + בלי כפילויות
const LANGUAGES_ABC: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'zh', name: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
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

  const [targetLang, setTargetLang] = useState<Language>(() => LANGUAGES_ABC.find((l) => l.code === 'en') || LANGUAGES_ABC[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => LANGUAGES_ABC.find((l) => l.code === 'he') || LANGUAGES_ABC[0]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(() => (SCENARIOS[1] as any));

  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [transcript, setTranscript] = useState<TranscriptionEntry[]>([]);
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [a11y, setA11y] = useState<A11yPrefs>({
    fontScale: 1,
    highContrast: false,
    reduceMotion: false,
    focusRing: true,
  });

  const [page, setPage] = useState<PageView>('main');

  // DEBUG: להבין למה זה נסגר
  const [lastEvent, setLastEvent] = useState<string>('—');

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const activeSessionRef = useRef<any>(null);

  // a11y load/save
  useEffect(() => {
    try {
      const saved = localStorage.getItem(A11Y_STORAGE_KEY);
      if (saved) setA11y(JSON.parse(saved));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(a11y));
    } catch {}
  }, [a11y]);

  useEffect(() => {
    if (a11y.reduceMotion) document.documentElement.classList.add('motion-reduce');
    else document.documentElement.classList.remove('motion-reduce');
  }, [a11y.reduceMotion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSettingsOpen(false);
    };
    if (isSettingsOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSettingsOpen]);

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

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {}
      processorRef.current = null;
    }

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

  useEffect(() => () => stopConversation(), [stopConversation]);

  const isAudioInline = (part: any) => {
    const mt = part?.inlineData?.mimeType || part?.inlineData?.mime_type || '';
    return typeof mt === 'string' && mt.toLowerCase().startsWith('audio/');
  };

  const safeErr = (e: any) => {
    const msg = e?.message ? String(e.message) : String(e);
    return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
  };

  const startConversation = useCallback(async () => {
    setError(null);
    setErrorDetails(null);
    setLastEvent('starting…');

    const apiKey = (import.meta as any).env?.VITE_API_KEY;
    if (!apiKey) {
      setError('Missing API Key. Please set VITE_API_KEY in Cloudflare Pages → Settings → Variables.');
      setStatus(ConnectionStatus.ERROR);
      setLastEvent('ERROR: missing api key');
      return;
    }

    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    setStatus(ConnectionStatus.CONNECTING);

    try {
      // חשוב: חייב להיות אחרי לחיצה במובייל
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      if (!inputAudioContextRef.current) inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });

      try { await inputAudioContextRef.current.resume(); } catch {}
      try { await outputAudioContextRef.current.resume(); } catch {}

      const ai = new GoogleGenAI({ apiKey });

      const isTranslator = (selectedScenario as any)?.id === 'translator';
      const systemInstruction = isTranslator
        ? `You are a professional real-time translator. Translate ${nativeLang.name} to ${targetLang.name} and vice versa. Speak ONLY the translation.`
        : `You are a patient and friendly ${targetLang.name} tutor. User's native language is ${nativeLang.name}. Scenario: ${(selectedScenario as any).title}. Correct errors gently and keep the conversation flowing.`;

      const MODEL_NAME = (import.meta as any).env?.VITE_GEMINI_MODEL || 'gemini-2.0-flash-live-001';

      const session = await ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setLastEvent('OPEN ✅');
            setStatus(ConnectionStatus.CONNECTED);

            const inputCtx = inputAudioContextRef.current!;
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              if (isMutedRef.current) return;
              const s = activeSessionRef.current;
              if (!s) return;

              try {
                s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
              } catch (err: any) {
                setError('Audio send error.');
                setErrorDetails(safeErr(err));
                setLastEvent('ERROR: sendRealtimeInput');
              }
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },

          onmessage: async (m: LiveServerMessage) => {
            try {
              if (m.serverContent?.interrupted) {
                sourcesRef.current.forEach((src) => {
                  try { src.stop(); } catch {}
                });
                sourcesRef.current.clear();
                nextStartTimeRef.current = 0;
                setIsSpeaking(false);
              }

              if (m.serverContent?.inputTranscription?.text) {
                currentInputTranscriptionRef.current += m.serverContent.inputTranscription.text;
              }
              if (m.serverContent?.outputTranscription?.text) {
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
              for (const part of parts as any[]) {
                if (!part?.inlineData?.data) continue;
                if (!isAudioInline(part)) continue;

                setIsSpeaking(true);

                try {
                  const pcm = decode(part.inlineData.data);
                  const outputCtx = outputAudioContextRef.current!;
                  try { await outputCtx.resume(); } catch {}

                  const audioBuffer = await decodeAudioData(outputCtx, pcm);

                  const sourceNode = outputCtx.createBufferSource();
                  sourceNode.buffer = audioBuffer;
                  sourceNode.connect(outputCtx.destination);

                  const now = outputCtx.currentTime;
                  const startAt = Math.max(now, nextStartTimeRef.current);
                  sourceNode.start(startAt);
                  nextStartTimeRef.current = startAt + audioBuffer.duration;

                  sourcesRef.current.add(sourceNode);
                  sourceNode.onended = () => {
                    sourcesRef.current.delete(sourceNode);
                    if (sourcesRef.current.size === 0) setIsSpeaking(false);
                  };
                } catch (decodeErr: any) {
                  setError('Audio decode error (skipped chunk).');
                  setErrorDetails(safeErr(decodeErr));
                  setLastEvent('ERROR: decode audio chunk');
                  setIsSpeaking(false);
                }
              }
            } catch (err: any) {
              setError('Audio/session error.');
              setErrorDetails(safeErr(err));
              setLastEvent('ERROR: onmessage');
              setIsSpeaking(false);
            }
          },

          // ✅ נוסיף מידע אם מגיע event
          onclose: (evt?: any) => {
            const code = evt?.code ? ` code=${evt.code}` : '';
            const reason = evt?.reason ? ` reason=${evt.reason}` : '';
            setLastEvent(`CLOSE ❌ (server closed)${code}${reason}`);
            setIsSpeaking(false);
            setStatus(ConnectionStatus.DISCONNECTED);
          },

          onerror: (e: any) => {
            setError('Session error. Please try again.');
            setErrorDetails(safeErr(e));
            setLastEvent('ERROR: onerror');
            setIsSpeaking(false);
            setStatus(ConnectionStatus.ERROR);
          },
        },

        // ✅ FIX: חייב להיות Modality.AUDIO ולא "AUDIO"
        config: {
          systemInstruction,
          responseModalities: [Modality.AUDIO],
        } as any,
      });

      activeSessionRef.current = session;
    } catch (err: any) {
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Microphone permission denied. Please allow microphone access and try again.'
          : 'Could not start. Please refresh and try again.';

      setError(msg);
      setErrorDetails(safeErr(err));
      setLastEvent(`ERROR: startConversation (${err?.name || 'unknown'})`);
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  }, [nativeLang.name, targetLang.name, selectedScenario, status, stopConversation]);

  const fontScaleStyle: React.CSSProperties = useMemo(() => ({ fontSize: `${a11y.fontScale * 100}%` }), [a11y.fontScale]);

  const rootClasses = useMemo(
    () =>
      [
        'min-h-dvh',
        'w-dvw',
        'bg-slate-950',
        'text-slate-200',
        a11y.highContrast ? 'contrast-125 saturate-125' : '',
      ]
        .filter(Boolean)
        .join(' '),
    [a11y.highContrast]
  );

  const incFont = () => setA11y((p) => ({ ...p, fontScale: p.fontScale === 1 ? 1.15 : 1.3 }));
  const decFont = () => setA11y((p) => ({ ...p, fontScale: p.fontScale === 1.3 ? 1.15 : 1 }));

  const FooterLinks = () => (
    <div className="flex items-center justify-center gap-4 text-[11px] text-slate-500">
      <button onClick={() => setPage('privacy')} className="hover:text-slate-300">
        Privacy
      </button>
      <button onClick={() => setPage('terms')} className="hover:text-slate-300">
        Terms
      </button>
      <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-300">
        Contact
      </a>
    </div>
  );

  const MainPage = () => (
    <div className={rootClasses} style={fontScaleStyle}>
      <div className="min-h-dvh w-full flex flex-col md:flex-row">
        {/* Sidebar */}
        <aside className="w-full md:w-96 bg-slate-900 border-b md:border-b-0 md:border-r border-white/5 p-4 md:p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                <Headphones className="text-white" />
              </div>
              <div className="leading-tight">
                <div className="text-lg font-black">LingoLive</div>
                <div className="text-[11px] text-slate-400">language practice & live translation</div>
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

          <div className="grid grid-cols-3 gap-3 items-start">
            {/* Languages 33% */}
            <div className="col-span-1 space-y-2">
              <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Languages</div>

              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400">Learn</div>
                  <select
                    value={targetLang.code}
                    onChange={(e) => setTargetLang(LANGUAGES_ABC.find((l) => l.code === e.target.value) || LANGUAGES_ABC[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    aria-label="Select learning language"
                  >
                    {LANGUAGES_ABC.map((l) => (
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
                    onChange={(e) => setNativeLang(LANGUAGES_ABC.find((l) => l.code === e.target.value) || LANGUAGES_ABC[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-2 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    aria-label="Select native language"
                  >
                    {LANGUAGES_ABC.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.flag} {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Modes 66% */}
            <div className="col-span-2 space-y-2">
              <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Mode</div>
              <div className="space-y-2">
                {SCENARIOS.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedScenario(s)}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className={[
                      'w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                      selectedScenario?.id === s.id ? 'bg-indigo-600/20 border-indigo-500' : 'bg-slate-800/40 border-transparent hover:bg-slate-800',
                    ].join(' ')}
                    aria-label={`Select mode ${s.title}`}
                  >
                    <span className="text-lg">{s.icon}</span>
                    <div>
                      <div className="font-black text-xs">{s.title}</div>
                      <div className="text-[10px] text-slate-500">{s.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-2 pt-3 border-t border-white/5 flex flex-col gap-2">
            <div className="text-[10px] text-slate-500 text-center">Last event: {lastEvent}</div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <div>© 2025 LingoLive</div>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
                aria-label="Open settings"
                title="Settings"
              >
                <Settings size={16} />
              </button>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 flex flex-col">
          <div className="flex-1 overflow-y-auto md:overflow-hidden px-4 md:px-8 py-4 md:py-8">
            <div className="relative w-full h-full flex flex-col items-center justify-start md:justify-center gap-4 md:gap-6">
              <div className="absolute top-4 right-4 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
                <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
                <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
                <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
              </div>

              {status === ConnectionStatus.CONNECTED ? (
                <div className="w-full max-w-xl flex items-center justify-center gap-3 mt-12 md:mt-0">
                  <button
                    onClick={() => setIsMuted((m) => !m)}
                    className={`px-5 py-3 rounded-2xl font-black flex items-center gap-2 border transition ${
                      isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 hover:border-indigo-500'
                    }`}
                    aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  >
                    {isMuted ? <MicOff /> : <Mic />} {isMuted ? 'MIC MUTED' : 'MIC ON'}
                  </button>

                  <button
                    onClick={stopConversation}
                    className="bg-red-600 px-6 py-3 rounded-2xl font-black flex items-center gap-2 hover:bg-red-700 transition-colors"
                    aria-label="Stop"
                  >
                    <LogOut /> STOP
                  </button>
                </div>
              ) : (
                <button
                  onClick={startConversation}
                  disabled={status === ConnectionStatus.CONNECTING}
                  className="w-full max-w-xl bg-indigo-600 px-6 py-4 rounded-3xl font-black flex items-center justify-center gap-3 text-lg shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed mt-12 md:mt-0"
                  aria-label="Start live session"
                >
                  <Mic size={22} />
                  {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
              )}

              <div className="scale-[0.8] md:scale-100 origin-top">
                <Avatar state={status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'} />
              </div>

              <div className="text-center space-y-1">
                <h2 className="text-2xl md:text-4xl font-black text-white tracking-tight">
                  {status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'Gemini is speaking' : 'Listening...') : (selectedScenario as any)?.title}
                </h2>
                <p className="text-slate-500 text-sm max-w-md mx-auto">{(selectedScenario as any)?.description}</p>
              </div>

              {(error || errorDetails) && (
                <div className="max-w-xl w-full text-red-200 text-xs font-black bg-red-400/10 px-4 py-3 rounded-xl border border-red-400/20">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={14} />
                    <div>{error || 'Error'}</div>
                  </div>
                  {errorDetails && <div className="mt-2 text-[11px] text-red-200/80 font-mono break-words">{errorDetails}</div>}
                </div>
              )}

              <div className="pb-[calc(env(safe-area-inset-bottom)+18px)]" />
              <FooterLinks />
            </div>
          </div>
        </main>
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div className="w-full max-w-lg bg-slate-950 border border-white/10 rounded-2xl shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Accessibility />
                <h3 className="text-lg font-black">Settings</h3>
              </div>
              <button className="p-2 rounded-xl hover:bg-white/5 border border-white/10" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <div className="p-4 rounded-2xl bg-slate-900/60 border border-white/10">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-sm font-black">Text size</div>
                  <div className="flex items-center gap-2">
                    <button className="p-2 rounded-xl border border-white/10 hover:bg-white/5" onClick={decFont} aria-label="Decrease text size">
                      <Minus size={16} />
                    </button>
                    <div className="text-xs font-black w-16 text-center">{a11y.fontScale === 1 ? '100%' : a11y.fontScale === 1.15 ? '115%' : '130%'}</div>
                    <button className="p-2 rounded-xl border border-white/10 hover:bg-white/5" onClick={incFont} aria-label="Increase text size">
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
                      setPage('privacy');
                    }}
                    className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10"
                  >
                    Privacy
                  </button>
                  <button
                    onClick={() => {
                      setIsSettingsOpen(false);
                      setPage('terms');
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

              <div className="flex justify-end">
                <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-black text-xs">
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const PrivacyPage = () => (
    <div className={rootClasses} style={fontScaleStyle}>
      <div className="min-h-dvh w-full flex flex-col items-center justify-center p-6 text-slate-200">
        <div className="w-full max-w-3xl bg-slate-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black">Privacy Policy</h1>
            <button onClick={() => setPage('main')} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 font-black text-xs">
              Back
            </button>
          </div>
          <p className="text-sm text-slate-300">
            This app uses your microphone only after you click “Start Live Session”. Audio is processed for the purpose of live translation / conversation.
          </p>
          <p className="text-sm text-slate-300">We do not sell personal data. If you have questions, contact: {CONTACT_EMAIL}</p>
        </div>
        <div className="mt-4">
          <FooterLinks />
        </div>
      </div>
    </div>
  );

  const TermsPage = () => (
    <div className={rootClasses} style={fontScaleStyle}>
      <div className="min-h-dvh w-full flex flex-col items-center justify-center p-6 text-slate-200">
        <div className="w-full max-w-3xl bg-slate-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black">Terms</h1>
            <button onClick={() => setPage('main')} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 font-black text-xs">
              Back
            </button>
          </div>
          <p className="text-sm text-slate-300">By using this app, you agree to use it responsibly. Do not use it for illegal activity.</p>
          <p className="text-sm text-slate-300">The service is provided “as is”, without warranties. If you need support contact: {CONTACT_EMAIL}</p>
        </div>
        <div className="mt-4">
          <FooterLinks />
        </div>
      </div>
    </div>
  );

  if (page === 'privacy') return <PrivacyPage />;
  if (page === 'terms') return <TermsPage />;
  return <MainPage />;
};

export default App;
