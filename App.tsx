import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import {
  Mic,
  MicOff,
  Headphones,
  LogOut,
  AlertCircle,
  Settings,
  X,
  ChevronDown,
  PanelLeftOpen,
} from 'lucide-react';

import Avatar from './components/avatar';
import AudioVisualizer from './components/audiovisualizer';

// -------------------------
// Types (local, to be robust)
// -------------------------
type Language = { code: string; name: string; flag: string };

type Scenario = {
  id: 'translator' | 'chat' | 'expert';
  title: string;
  description: string;
  icon: string;
};

enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

// -------------------------
// Languages (ABC, deduped)
// -------------------------
const LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'zh', name: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱' },
]
  .sort((a, b) => a.name.localeCompare(b.name));

// -------------------------
// Scenarios
// -------------------------
const SCENARIOS: Scenario[] = [
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

// -------------------------
// Live model (IMPORTANT)
// From Google Live API docs
// -------------------------
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'; // :contentReference[oaicite:2]{index=2}

// -------------------------
// Accessibility prefs
// -------------------------
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
  const [error, setError] = useState<string>('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const [targetLang, setTargetLang] = useState<Language>(() => LANGUAGES.find(l => l.code === 'en') || LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(() => LANGUAGES.find(l => l.code === 'he') || LANGUAGES[0]);
  const [selectedScenario, setSelectedScenario] = useState<Scenario>(SCENARIOS[1]);

  // Mobile UI
  const [isMobilePanelOpen, setIsMobilePanelOpen] = useState(false);

  // Settings
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [a11y, setA11y] = useState<A11yPrefs>({
    fontScale: 1,
    highContrast: false,
    reduceMotion: false,
    focusRing: true,
  });

  // Audio + Live session refs
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const isStoppingRef = useRef(false);

  // ---------- A11y load/save ----------
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

  // ---------- helpers ----------
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

  const safeWsSend = (data: any) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) return; // ✅ avoid "CLOSING/CLOSED" spam
    ws.send(JSON.stringify(data));
  };

  const stopConversation = useCallback(() => {
    isStoppingRef.current = true;

    try {
      setIsSpeaking(false);

      // Stop processor
      if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
        scriptProcessorRef.current = null;
      }

      // Stop mic source
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }

      // Stop mic stream tracks
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }

      // Close audio context
      if (inputAudioContextRef.current) {
        inputAudioContextRef.current.close().catch(() => {});
        inputAudioContextRef.current = null;
      }

      // Close ws
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    } finally {
      setStatus(ConnectionStatus.DISCONNECTED);
      setIsMuted(false);
      isStoppingRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => stopConversation();
  }, [stopConversation]);

  const startConversation = useCallback(async () => {
    setError('');

    // If something left open – close first
    stopConversation();

    const apiKey = (import.meta as any).env?.VITE_API_KEY;
    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    setStatus(ConnectionStatus.CONNECTING);

    try {
      // 1) mic permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      // 2) audio context (must start from click gesture)
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioContextRef.current = inputCtx;
      await inputCtx.resume().catch(() => {});

      const source = inputCtx.createMediaStreamSource(stream);
      micSourceRef.current = source;

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      // 3) connect Live API via SDK (WebSocket internally)
      // @google/genai creates a WebSocket under the hood for live
      const ai = new GoogleGenAI({ apiKey });

      // The SDK gives you a live session with a ws-like transport.
      // We implement with the SDK's connect style:
      const session = await (ai as any).live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
        },
      });

      // session has a websocket-like object at session._ws in many builds,
      // but we keep it generic: prefer session.send / session.onmessage when present.
      // Still, we store the underlying ws if exposed so we can guard sends.
      wsRef.current = (session as any)?.ws || (session as any)?._ws || null;

      // 4) handle responses
      session.onmessage = (msg: any) => {
        // Some SDK builds pass structured messages
        // We only need to know when speaking/audio is coming
        try {
          // If an audio chunk exists, treat as speaking
          const hasAudio =
            msg?.type === 'response.audio' ||
            msg?.serverContent?.modelTurn?.parts?.some((p: any) => p?.inlineData?.mimeType?.startsWith('audio/'));

          if (hasAudio) setIsSpeaking(true);
        } catch {}
      };

      session.onclose = (ev: any) => {
        if (isStoppingRef.current) return;

        // Try to surface helpful reason
        const reason = ev?.reason || '';
        setStatus(ConnectionStatus.ERROR);

        if (String(reason).toLowerCase().includes('model') || String(reason).includes('1008')) {
          setError(
            'Server closed the Live session (1008). Usually this means the model name is wrong or the API key lacks access/quota. We set the correct Live model, so if it still happens: create a fresh API key in AI Studio and update VITE_API_KEY.'
          );
        } else {
          setError('Audio/session error. Please refresh the page and try again.');
        }

        // cleanup
        stopConversation();
      };

      session.onerror = (e: any) => {
        if (isStoppingRef.current) return;
        setStatus(ConnectionStatus.ERROR);
        setError('Audio/session error. Please refresh the page and try again.');
        stopConversation();
      };

      // 5) wire mic -> live input
      processor.onaudioprocess = async (e: AudioProcessingEvent) => {
        // If muted or not connected, do nothing
        if (isMuted) return;
        if (status !== ConnectionStatus.CONNECTED && status !== ConnectionStatus.CONNECTING) return;

        // Convert float32 to 16-bit PCM
        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send audio to session (SDK)
        try {
          // Prefer official sendRealtimeInput if present
          if (typeof session.sendRealtimeInput === 'function') {
            await session.sendRealtimeInput(pcm16);
          } else if (typeof session.send === 'function') {
            // Fallback (rare)
            session.send({ type: 'input_audio_buffer.append', audio: pcm16 });
          } else {
            // Last resort: direct ws send if exposed
            safeWsSend({ type: 'input_audio_buffer.append', audio: Array.from(pcm16) });
          }
        } catch {
          // If socket closed mid-stream, stop spam and close
          if (!isStoppingRef.current) {
            setStatus(ConnectionStatus.ERROR);
            setError('Connection closed while streaming audio. Please try again.');
            stopConversation();
          }
        }
      };

      source.connect(processor);
      processor.connect(inputCtx.destination);

      setStatus(ConnectionStatus.CONNECTED);
    } catch (err: any) {
      setStatus(ConnectionStatus.ERROR);

      // Common: mic permissions blocked
      const msg = String(err?.message || err || '');
      if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied')) {
        setError('Microphone permission denied. Please allow mic access in the browser and try again.');
      } else {
        setError('Could not start audio session. Please refresh and try again.');
      }
      stopConversation();
    }
  }, [isMuted, status, stopConversation]);

  // UI labels
  const modeTitle = selectedScenario.title;
  const modeDesc = selectedScenario.description;

  const showFooterRight = true;

  return (
    <div className={rootClasses} style={fontScaleStyle}>
      <div className="h-full w-full flex overflow-hidden">
        {/* LEFT PANEL (desktop) */}
        <aside className="hidden md:flex w-[33%] min-w-[320px] max-w-[420px] h-full bg-slate-900 border-r border-white/5 p-5 flex-col gap-4 overflow-hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                <Headphones className="text-white" />
              </div>
              <div>
                <div className="text-xl font-black leading-tight">LingoLive</div>
                <div className="text-[11px] text-slate-400 -mt-0.5">language practice & live translation</div>
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

          {/* LANG + MODE in 2 columns */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Languages</div>

              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400">Learn</div>
                  <select
                    value={targetLang.code}
                    onChange={(e) => setTargetLang(LANGUAGES.find((l) => l.code === e.target.value) || LANGUAGES[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    aria-label="Select learning language"
                  >
                    {LANGUAGES.map((l) => (
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
                    onChange={(e) => setNativeLang(LANGUAGES.find((l) => l.code === e.target.value) || LANGUAGES[0])}
                    disabled={status !== ConnectionStatus.DISCONNECTED}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    aria-label="Select native language"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.flag} {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

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
                    <span className="text-xl">{s.icon}</span>
                    <div>
                      <div className="font-bold text-xs">{s.title}</div>
                      <div className="text-[10px] text-slate-500">{s.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Left footer moved away from START */}
          <div className="mt-auto flex items-center justify-between text-[11px] text-slate-500 pt-2">
            <div>© 2025 LingoLive</div>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
              aria-label="Open settings"
              title="Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </aside>

        {/* RIGHT: MAIN */}
        <main className="flex-1 h-full overflow-hidden flex flex-col">
          {/* Top bar (mobile) */}
          <div className="md:hidden px-4 pt-4 pb-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                <Headphones className="text-white" />
              </div>
              <div>
                <div className="text-lg font-black leading-tight">LingoLive</div>
                <div className="text-[11px] text-slate-400 -mt-0.5">language practice & live translation</div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Clear button instead of "3 lines" */}
              <button
                onClick={() => setIsMobilePanelOpen((v) => !v)}
                className="px-3 py-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition flex items-center gap-2"
                aria-label="Open language and mode panel"
              >
                <PanelLeftOpen size={16} />
                <span className="text-xs font-black">Languages</span>
                <ChevronDown size={14} className={`transition ${isMobilePanelOpen ? 'rotate-180' : ''}`} />
              </button>

              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
                aria-label="Open settings"
              >
                <Settings size={18} />
              </button>
            </div>
          </div>

          {/* Mobile panel */}
          {isMobilePanelOpen && (
            <div className="md:hidden px-4 pb-3">
              <div className="bg-slate-900/80 border border-white/10 rounded-2xl p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-[10px] text-slate-400">Learn</div>
                    <select
                      value={targetLang.code}
                      onChange={(e) => setTargetLang(LANGUAGES.find((l) => l.code === e.target.value) || LANGUAGES[0])}
                      disabled={status !== ConnectionStatus.DISCONNECTED}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      {LANGUAGES.map((l) => (
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
                      onChange={(e) => setNativeLang(LANGUAGES.find((l) => l.code === e.target.value) || LANGUAGES[0])}
                      disabled={status !== ConnectionStatus.DISCONNECTED}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.flag} {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

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
                      <span className="text-xl">{s.icon}</span>
                      <div>
                        <div className="font-bold text-xs">{s.title}</div>
                        <div className="text-[10px] text-slate-500">{s.description}</div>
                      </div>
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setIsMobilePanelOpen(false)}
                  className="w-full py-2 rounded-xl bg-slate-800/60 border border-white/10 text-xs font-black"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Main content */}
          <div className="relative flex-1 overflow-hidden flex items-center justify-center px-6 md:px-10">
            {/* status pill */}
            <div className="absolute top-4 md:top-6 right-4 md:right-6 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
              <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
              <div
                className={`w-2 h-2 rounded-full ${
                  status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'
                }`}
              />
              <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
            </div>

            {/* Center stack: START always above avatar */}
            <div className="w-full max-w-3xl flex flex-col items-center justify-center text-center gap-5 md:gap-7">
              {/* Controls */}
              {status === ConnectionStatus.CONNECTED ? (
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
                    className={`px-5 py-3 rounded-2xl border-2 transition-all shadow-2xl flex items-center gap-2 ${
                      isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-800 border-slate-700 hover:border-indigo-500'
                    }`}
                    aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  >
                    {isMuted ? <MicOff /> : <Mic />}
                    <span className="text-xs font-black">{isMuted ? 'MIC OFF' : 'MIC ON'}</span>
                  </button>

                  <button
                    onClick={stopConversation}
                    className="bg-red-600 px-6 py-3 rounded-2xl font-black flex items-center gap-2 hover:bg-red-700 transition-colors shadow-2xl shadow-red-900/20"
                    aria-label="Stop"
                  >
                    <LogOut size={18} /> STOP
                  </button>
                </div>
              ) : (
                <button
                  onClick={startConversation}
                  disabled={status === ConnectionStatus.CONNECTING}
                  className="bg-indigo-600 w-full max-w-xl py-5 md:py-6 rounded-3xl font-black flex items-center justify-center gap-3 text-lg md:text-xl shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Start live session"
                >
                  <Mic size={26} /> {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
                </button>
              )}

              {/* Avatar (20% smaller than before) */}
              <div className="scale-[0.8] md:scale-[0.8]">
                <Avatar
                  state={
                    status !== ConnectionStatus.CONNECTED ? 'idle' : isSpeaking ? 'speaking' : isMuted ? 'thinking' : 'listening'
                  }
                />
              </div>

              <div className="space-y-1">
                <h2 className="text-3xl md:text-5xl font-black text-white tracking-tight">
                  {status === ConnectionStatus.CONNECTED
                    ? isSpeaking
                      ? 'Gemini is speaking'
                      : 'Listening...'
                    : modeTitle}
                </h2>
                <p className="text-slate-500 text-sm md:text-base max-w-2xl mx-auto">{modeDesc}</p>
              </div>

              {/* Error */}
              {error && (
                <div className="text-red-300 text-xs md:text-sm font-bold bg-red-400/10 px-4 py-3 rounded-xl border border-red-400/20 flex items-center gap-2 max-w-2xl">
                  <AlertCircle size={16} /> {error}
                </div>
              )}
            </div>
          </div>

          {/* Footer right area (privacy/terms/contact) */}
          {showFooterRight && (
            <div className="px-6 pb-4 flex items-center justify-center md:justify-end gap-4 text-[12px] text-slate-500">
              <a href="/privacy" className="hover:text-slate-200">Privacy</a>
              <a href="/terms" className="hover:text-slate-200">Terms</a>
              <a href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`} className="hover:text-slate-200">Contact</a>
            </div>
          )}
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
                <Settings />
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
                <div className="font-black text-sm mb-3">Accessibility</div>

                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-xs text-slate-300">Text size</div>
                  <div className="flex items-center gap-2">
                    <button
                      className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
                      onClick={decFont}
                      aria-label="Decrease text size"
                    >
                      -
                    </button>
                    <div className="text-xs font-black w-16 text-center">
                      {a11y.fontScale === 1 ? '100%' : a11y.fontScale === 1.15 ? '115%' : '130%'}
                    </div>
                    <button
                      className="p-2 rounded-xl border border-white/10 hover:bg-white/5"
                      onClick={incFont}
                      aria-label="Increase text size"
                    >
                      +
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-xs text-slate-300">High contrast</span>
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

