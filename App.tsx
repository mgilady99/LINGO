import React, { useState, useRef, useCallback, useEffect } from 'react';
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
  MousePointer2,
  Menu,
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
const CONTACT_EMAIL = 'callilcoil@gmail.com';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[0]);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptionEntry[]>([]);

  // Mobile panel (languages + mode + transcript)
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  // Settings modal
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

  // Load A11y prefs
  useEffect(() => {
    try {
      const saved = localStorage.getItem(A11Y_STORAGE_KEY);
      if (saved) setA11y(JSON.parse(saved));
    } catch {}
  }, []);

  // Save A11y prefs
  useEffect(() => {
    try {
      localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(a11y));
    } catch {}
  }, [a11y]);

  useEffect(() => {
    if (a11y.reduceMotion) document.documentElement.classList.add('motion-reduce');
    else document.documentElement.classList.remove('motion-reduce');
  }, [a11y.reduceMotion]);

  // ESC closes modals/panels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSettingsOpen(false);
        setIsPanelOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Auto-scroll transcript area only (when open + changes)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript, isPanelOpen]);

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
      setError('Missing API Key. Set VITE_API_KEY in Cloudflare Pages Variables and redeploy.');
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

      const systemInstruction =
        selectedScenario.id === 'translator'
          ? `You are a professional real-time translator. Translate ${nativeLang.name} to ${targetLang.name} and vice versa. Speak ONLY the translation.`
          : `You are a patient and friendly ${targetLang.name} tutor. User's native language is ${nativeLang.name}. Scenario: ${selectedScenario.title}. Keep it short and helpful.`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          systemInstruction,
        } as any,
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
              sourcesRef.current.forEach((src) => {
                try {
                  src.stop();
                } catch {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (m.serverContent?.inputTranscription) currentInputTranscriptionRef.current += m.serverContent.inputTranscription.text;
            if (m.serverContent?.outputTranscription) currentOutputTranscriptionRef.current += m.serverContent.outputTranscription.text;

            if (m.serverContent?.turnComplete) {
              const inText = currentInputTranscriptionRef.current.trim();
              const outText = currentOutputTranscriptionRef.current.trim();

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
                setIsSpeaking(true);
                const audioData = part.inlineData.data;

                const pcm = decode(audioData);
                const audioBuffer = await decodeAudioData(outputAudioContextRef.current!, pcm);

                const source = outputAudioContextRef.current!.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputAudioContextRef.current!.destination);

                const now = outputAudioContextRef.current!.currentTime;
                const startAt = Math.max(now, nextStartTimeRef.current);
                source.start(startAt);
                nextStartTimeRef.current = startAt + audioBuffer.duration;

                sourcesRef.current.add(source);
                source.onended = () => {
                  sourcesRef.current.delete(source);
                  if (sourcesRef.current.size === 0) setIsSpeaking(false);
                };
              }
            }
          },

          onclose: () => stopConversation(),
          onerror: () => {
            setError('Connection error.');
            setStatus(ConnectionStatus.ERROR);
            stopConversation();
          },
        },
      });

      const session = await sessionPromise;
      activeSessionRef.current = session;

      // Close mobile panel when session starts (so user sees avatar+controls)
      setIsPanelOpen(false);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || 'Failed to start.');
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  };

  const fontScaleStyle: React.CSSProperties = { fontSize: `${a11y.fontScale * 100}%` };
  const rootClasses = [
    'h-dvh w-dvw overflow-hidden bg-slate-950 text-slate-200',
    a11y.highContrast ? 'contrast-125 saturate-125' : '',
  ].join(' ');

  const incFont = () =>
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1 ? 1.15 : p.fontScale === 1.15 ? 1.3 : 1.3 }));
  const decFont = () =>
    setA11y((p) => ({ ...p, fontScale: p.fontScale === 1.3 ? 1.15 : p.fontScale === 1.15 ? 1 : 1 }));

  return (
    <div className={rootClasses} style={fontScaleStyle}>
      {/* Top bar (always visible in mobile + web) */}
      <header className="h-14 md:h-16 px-4 md:px-6 flex items-center justify-between border-b border-white/5 bg-slate-950/70 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <Headphones className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-black">LingoLive</div>
            <div className="text-[10px] text-slate-400">language practice & live translation</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mobile panel button */}
          <button
            onClick={() => setIsPanelOpen(true)}
            className="md:hidden p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>

          {/* Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
            aria-label="Open settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* Main app body */}
      <div className="h-[calc(100dvh-56px)] md:h-[calc(100dvh-64px)] flex overflow-hidden">
        {/* Desktop sidebar (only on md+) */}
        <aside className="hidden md:flex w-80 h-full bg-slate-900 border-r border-white/5 p-5 flex-col gap-5 overflow-hidden">
          {/* Languages (2 selects) */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>
            <div className="p-3 bg-slate-800/40 rounded-2xl border border-white/5 space-y-3">
              <div className="space-y-1">
                <div className="text-[10px] text-slate-400">Learn</div>
                <select
                  value={targetLang.code}
                  onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
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
                <div className="text-[10px] text-slate-400">Native</div>
                <select
                  value={nativeLang.code}
                  onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
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

          {/* Mode buttons */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mode</div>
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
                    <div className="font-bold text-xs">{s.title}</div>
                    <div className="text-[9px] text-slate-500">{s.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Transcript: NO title, NO placeholder text */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div ref={scrollRef} className="h-full overflow-y-auto space-y-1 pr-2">
              {transcript.map((entry, i) => (
                <TranscriptItem key={i} entry={entry} />
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="pt-2 text-[10px] text-slate-500 flex items-center justify-between">
            <span>© 2025 LingoLive</span>
            <div className="flex items-center gap-3">
              <a href="/privacy" className="hover:text-slate-300">
                Privacy
              </a>
              <a href="/terms" className="hover:text-slate-300">
                Terms
              </a>
              <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-300">
                Contact
              </a>
            </div>
          </div>
        </aside>

        {/* Main center (always visible on mobile + desktop) */}
        <main className="flex-1 h-full overflow-hidden flex flex-col items-center justify-center p-5 md:p-10 relative">
          {/* Status pill */}
          <div className="absolute top-4 right-4 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
            <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
            <div
              className={`w-2 h-2 rounded-full ${
                status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'
              }`}
            />
            <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
          </div>

          {/* START button ALWAYS on top */}
          <div className="w-full max-w-xl flex flex-col items-center gap-4">
            {error && (
              <div className="text-red-400 text-xs font-bold bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20 flex items-center gap-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            {status === ConnectionStatus.CONNECTED ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsMuted((m) => !m)}
                  className={`px-5 py-3 rounded-2xl border font-black flex items-center gap-2 ${
                    isMuted ? 'bg-red-500/20 border-red-400/40' : 'bg-slate-900/60 border-white/10'
                  }`}
                >
                  {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                  {isMuted ? 'Mic muted' : 'Mic on'}
                </button>

                <button
                  onClick={stopConversation}
                  className="px-5 py-3 rounded-2xl bg-red-600 hover:bg-red-700 font-black flex items-center gap-2"
                >
                  <LogOut size={18} /> Exit
                </button>
              </div>
            ) : (
              <button
                onClick={startConversation}
                disabled={status === ConnectionStatus.CONNECTING}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-4 rounded-2xl font-black flex items-center justify-center gap-3 text-base md:text-lg shadow-2xl shadow-indigo-900/40"
              >
                <Mic size={22} />
                {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
              </button>
            )}

            {/* Avatar (20% smaller than before) */}
            <div className="scale-[0.8] origin-top">
              <Avatar
                state={
                  status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'
                }
              />
            </div>

            <div className="text-center">
              <div className="text-2xl md:text-4xl font-black text-white">
                {status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'Gemini is speaking' : 'Listening...') : selectedScenario.title}
              </div>
              <div className="text-slate-500 text-sm mt-1">{selectedScenario.description}</div>
            </div>

            {/* Mobile footer links (bottom) */}
            <div className="md:hidden fixed bottom-3 left-0 right-0 flex items-center justify-center gap-4 text-[11px] text-slate-400">
              <a href="/privacy" className="hover:text-slate-200">
                Privacy
              </a>
              <a href="/terms" className="hover:text-slate-200">
                Terms
              </a>
              <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-200">
                Contact
              </a>
            </div>
          </div>
        </main>
      </div>

      {/* Mobile Panel (Languages + Mode + Transcript) */}
      {isPanelOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setIsPanelOpen(false)}>
          <div
            className="absolute left-0 top-0 bottom-0 w-[86%] max-w-sm bg-slate-900 border-r border-white/10 p-4 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="font-black">Menu</div>
              <button
                onClick={() => setIsPanelOpen(false)}
                className="p-2 rounded-xl border border-white/10 bg-slate-950/40"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>

            {/* Languages */}
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>
              <div className="p-3 bg-slate-800/40 rounded-2xl border border-white/5 space-y-3">
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400">Learn</div>
                  <select
                    value={targetLang.code}
                    onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
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
                  <div className="text-[10px] text-slate-400">Native</div>
                  <select
                    value={nativeLang.code}
                    onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value)!)}
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

            {/* Mode */}
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mode</div>
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
                      <div className="font-bold text-xs">{s.title}</div>
                      <div className="text-[9px] text-slate-500">{s.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Transcript: no label, no placeholder */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <div ref={scrollRef} className="h-full overflow-y-auto space-y-1 pr-2">
                {transcript.map((entry, i) => (
                  <TranscriptItem key={i} entry={entry} />
                ))}
              </div>
            </div>

            <div className="text-[10px] text-slate-500 flex items-center justify-between pt-2">
              <span>© 2025</span>
              <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-200">
                Contact
              </a>
            </div>
          </div>
        </div>
      )}

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
                    <button className="p-2 rounded-xl border border-white/10 hover:bg-white/5" onClick={decFont}>
                      <Minus size={16} />
                    </button>
                    <div className="text-xs font-black w-16 text-center">
                      {a11y.fontScale === 1 ? '100%' : a11y.fontScale === 1.15 ? '115%' : '130%'}
                    </div>
                    <button className="p-2 rounded-xl border border-white/10 hover:bg-white/5" onClick={incFont}>
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
                  />
                </label>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300">Reduce motion</span>
                  <input
                    type="checkbox"
                    checked={a11y.reduceMotion}
                    onChange={(e) => setA11y((p) => ({ ...p, reduceMotion: e.target.checked }))}
                    className="h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300">Show focus outline</span>
                  <input
                    type="checkbox"
                    checked={a11y.focusRing}
                    onChange={(e) => setA11y((p) => ({ ...p, focusRing: e.target.checked }))}
                    className="h-4 w-4"
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
