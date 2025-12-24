import React, { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import {
  Headphones,
  Mic,
  MicOff,
  LogOut,
  Settings,
  Globe,
  MessageCircle,
  GraduationCap,
  AlertCircle,
} from "lucide-react";

type Language = { code: string; name: string; flag: string };

const SUPPORTED_LANGUAGES: Language[] = [
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "zh", name: "Chinese (Mandarin)", flag: "🇨🇳" },
  { code: "en", name: "English", flag: "🇺🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "he", name: "Hebrew", flag: "🇮🇱" },
].sort((a, b) => a.name.localeCompare(b.name));

type ModeId = "translator" | "chat" | "tutor";
type Mode = { id: ModeId; title: string; desc: string; icon: React.ReactNode };

const MODES: Mode[] = [
  {
    id: "translator",
    title: "Real-time Translator",
    desc: "Bi-directional translation between 2 languages.",
    icon: <Globe size={18} />,
  },
  {
    id: "chat",
    title: "Casual Chat",
    desc: "Friendly conversation to build fluency.",
    icon: <MessageCircle size={18} />,
  },
  {
    id: "tutor",
    title: "Expert Tutor",
    desc: "Intensive practice with corrections.",
    icon: <GraduationCap size={18} />,
  },
];

const CONTACT_EMAIL = "callilcoil@gmail.com";

// ✅ Live API model (updated – old *-live names can break)
// From Google Live API docs example :contentReference[oaicite:2]{index=2}
const LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

enum ConnStatus {
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  ERROR = "ERROR",
}

export default function App() {
  const [status, setStatus] = useState<ConnStatus>(ConnStatus.DISCONNECTED);
  const [error, setError] = useState<string>("");
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES.find(l => l.code === "en") || SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES.find(l => l.code === "he") || SUPPORTED_LANGUAGES[0]);
  const [mode, setMode] = useState<Mode>(MODES[1]);

  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // --- audio / live session refs ---
  const liveSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const isClosingRef = useRef(false);

  // simple UI state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // helper: stop everything safely
  const stopConversation = useCallback(async () => {
    isClosingRef.current = true;

    try {
      // stop mic processor first (prevents "send on closed socket" spam)
      if (processorRef.current) {
        try {
          processorRef.current.disconnect();
        } catch {}
        processorRef.current.onaudioprocess = null;
        processorRef.current = null;
      }
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.disconnect();
        } catch {}
        sourceNodeRef.current = null;
      }

      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }

      if (inputCtxRef.current) {
        try {
          await inputCtxRef.current.close();
        } catch {}
        inputCtxRef.current = null;
      }

      if (outputCtxRef.current) {
        try {
          await outputCtxRef.current.close();
        } catch {}
        outputCtxRef.current = null;
      }

      if (liveSessionRef.current) {
        try {
          await liveSessionRef.current.close();
        } catch {}
        liveSessionRef.current = null;
      }
    } finally {
      setStatus(ConnStatus.DISCONNECTED);
      isClosingRef.current = false;
    }
  }, []);

  // stop on unmount
  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, [stopConversation]);

  const startConversation = useCallback(async () => {
    setError("");
    if (status === ConnStatus.CONNECTING || status === ConnStatus.CONNECTED) return;

    // cleanup before starting (important)
    await stopConversation();

    setStatus(ConnStatus.CONNECTING);

    const apiKey =
      (import.meta as any).env?.VITE_API_KEY ||
      (import.meta as any).env?.API_KEY;

    if (!apiKey) {
      setError("Missing API Key. Set VITE_API_KEY in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.");
      setStatus(ConnStatus.ERROR);
      return;
    }

    try {
      // mic permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      // audio contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });
      inputCtxRef.current = inputCtx;

      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });
      outputCtxRef.current = outputCtx;

      const ai = new GoogleGenAI({ apiKey });

      const config = {
        responseModalities: [Modality.AUDIO],
        // You can tune the instruction per mode:
        systemInstruction:
          mode.id === "translator"
            ? `You are a real-time translator. Translate between ${nativeLang.name} and ${targetLang.name}. Keep it short and natural.`
            : mode.id === "tutor"
              ? `You are an expert language tutor. The learner wants to practice ${targetLang.name}. Correct mistakes gently and explain briefly.`
              : `You are a friendly conversation partner. Help the user practice ${targetLang.name} naturally.`,
      };

      // connect live
      const session = await ai.live.connect({
        model: LIVE_MODEL,
        config,
        callbacks: {
          onopen: () => {
            if (isClosingRef.current) return;
            setStatus(ConnStatus.CONNECTED);
          },
          onclose: (evt: any) => {
            // server closes (including code 1008)
            if (isClosingRef.current) return;

            const msg =
              evt?.reason
                ? `Closed: ${evt.reason} (code ${evt.code})`
                : `Connection closed (code ${evt?.code ?? "?"})`;

            setError(msg);
            // cleanup to stop spamming sends
            stopConversation();
          },
          onerror: () => {
            if (isClosingRef.current) return;
            setError("Connection error. Please refresh and try again.");
            stopConversation();
          },
        },
      });

      liveSessionRef.current = session;

      // audio processing + sending
      const source = inputCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = async (e) => {
        // ✅ do not send if muted / not connected / closing
        if (isClosingRef.current) return;
        if (isMutedRef.current) return;
        if (!liveSessionRef.current) return;
        if (status !== ConnStatus.CONNECTED) return;

        // Convert float32 to 16-bit PCM
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        try {
          await liveSessionRef.current.sendRealtimeInput({
            audio: {
              data: pcm,
              mimeType: "audio/pcm",
            },
          });
        } catch {
          // if socket is closed, stop the loop cleanly
          if (!isClosingRef.current) {
            stopConversation();
          }
        }
      };

      source.connect(processor);
      processor.connect(inputCtx.destination);

      // receive loop (audio playback)
      (async () => {
        try {
          while (liveSessionRef.current && !isClosingRef.current) {
            const msg: LiveServerMessage = await liveSessionRef.current.receive();
            if (!msg) continue;

            // server sends audio chunks in msg.serverContent.modelTurn.parts[].inlineData
            const parts = msg?.serverContent?.modelTurn?.parts || [];
            for (const p of parts) {
              const inline = (p as any)?.inlineData?.data;
              if (!inline) continue;

              // inline can be Uint8Array / ArrayBuffer
              const bytes =
                inline instanceof ArrayBuffer
                  ? new Uint8Array(inline)
                  : inline instanceof Uint8Array
                    ? inline
                    : null;

              if (!bytes) continue;

              // decode pcm 16-bit little endian @ 24k and play
              const audioBuffer = outputCtx.createBuffer(1, bytes.length / 2, 24000);
              const channel = audioBuffer.getChannelData(0);
              const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              for (let i = 0; i < channel.length; i++) {
                const v = view.getInt16(i * 2, true);
                channel[i] = v / 32768;
              }
              const src = outputCtx.createBufferSource();
              src.buffer = audioBuffer;
              src.connect(outputCtx.destination);
              src.start();
            }
          }
        } catch {
          // ignore; stopConversation handles cleanup
        }
      })();

    } catch (e: any) {
      setStatus(ConnStatus.ERROR);
      setError(e?.message || "Failed to start. Check mic permission and API key.");
      stopConversation();
    }
  }, [mode.id, nativeLang.name, targetLang.name, status, stopConversation]);

  // UI: mobile safe area + layout
  return (
    <div className="h-dvh w-dvw overflow-hidden bg-slate-950 text-slate-200">
      <div className="h-full w-full flex flex-col md:flex-row overflow-hidden">

        {/* LEFT PANEL */}
        <aside className="w-full md:w-[360px] shrink-0 bg-slate-900/60 border-r border-white/5 p-4 md:p-6 overflow-hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                <Headphones className="text-white" />
              </div>
              <div>
                <div className="text-lg font-black leading-tight">LingoLive</div>
                <div className="text-[11px] text-slate-400">language practice & live translation</div>
              </div>
            </div>

            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-xl border border-white/10 bg-slate-900/60 hover:bg-slate-800/60 transition"
              aria-label="Open settings"
              title="Settings"
            >
              <Settings size={18} />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="col-span-1">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Learn</div>
              <select
                value={targetLang.code}
                onChange={(e) => setTargetLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) || SUPPORTED_LANGUAGES[0])}
                disabled={status !== ConnStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-1">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Native</div>
              <select
                value={nativeLang.code}
                onChange={(e) => setNativeLang(SUPPORTED_LANGUAGES.find((l) => l.code === e.target.value) || SUPPORTED_LANGUAGES[0])}
                disabled={status !== ConnStatus.DISCONNECTED}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Mode</div>
            <div className="space-y-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m)}
                  disabled={status !== ConnStatus.DISCONNECTED}
                  className={[
                    "w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all",
                    m.id === mode.id
                      ? "bg-indigo-600/20 border-indigo-500"
                      : "bg-slate-800/30 border-white/5 hover:bg-slate-800/50",
                  ].join(" ")}
                >
                  <div className="mt-0.5 text-indigo-200">{m.icon}</div>
                  <div className="min-w-0">
                    <div className="font-black text-sm truncate">{m.title}</div>
                    <div className="text-[11px] text-slate-400 leading-snug">{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* footer moved down so it won't hide START on mobile */}
          <div className="mt-4 md:mt-6 pt-3 border-t border-white/5 flex items-center justify-between text-[11px] text-slate-500">
            <div>© 2025 LingoLive</div>
            <a className="hover:text-slate-300" href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`}>
              Contact
            </a>
          </div>
        </aside>

        {/* MAIN */}
        <main className="flex-1 h-full overflow-hidden relative">
          <div className="h-full w-full flex flex-col items-center justify-center px-4 md:px-8 text-center">

            {/* status pill */}
            <div className="absolute top-4 md:top-6 right-4 md:right-6 flex items-center gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 shadow-xl">
              <div className={`w-2 h-2 rounded-full ${status === ConnStatus.CONNECTED ? "bg-green-500 animate-pulse" : "bg-slate-700"}`} />
              <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
            </div>

            {/* START always visible on mobile */}
            <div className="w-full max-w-xl flex flex-col items-center gap-4 md:gap-6">
              {status === ConnStatus.CONNECTED ? (
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={() => setIsMuted((v) => !v)}
                    className={[
                      "px-5 py-3 rounded-2xl font-black border transition",
                      isMuted ? "bg-red-600 border-red-400" : "bg-slate-900 border-white/10 hover:bg-slate-800",
                    ].join(" ")}
                  >
                    <span className="inline-flex items-center gap-2">
                      {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                      {isMuted ? "MIC OFF" : "MIC ON"}
                    </span>
                  </button>

                  <button
                    onClick={stopConversation}
                    className="px-5 py-3 rounded-2xl font-black bg-red-600 hover:bg-red-700 transition border border-red-400/30"
                  >
                    <span className="inline-flex items-center gap-2">
                      <LogOut size={18} /> STOP
                    </span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={startConversation}
                  disabled={status === ConnStatus.CONNECTING}
                  className="w-full max-w-xl bg-indigo-600 py-4 md:py-5 rounded-3xl font-black flex items-center justify-center gap-3 text-lg md:text-xl shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition disabled:opacity-50"
                >
                  <Mic size={22} />
                  {status === ConnStatus.CONNECTING ? "CONNECTING..." : "START LIVE SESSION"}
                </button>
              )}

              {/* avatar */}
              <div className="w-[220px] h-[220px] md:w-[280px] md:h-[280px] rounded-full overflow-hidden ring-2 ring-white/10 shadow-2xl">
                <img
                  src="/avatar.jpg"
                  alt="Avatar"
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </div>

              <div>
                <div className="text-3xl md:text-5xl font-black text-white">{mode.title}</div>
                <div className="text-slate-400 text-sm md:text-base mt-1">{mode.desc}</div>
              </div>

              {error && (
                <div className="w-full max-w-xl text-red-300 text-xs md:text-sm font-bold bg-red-500/10 px-4 py-3 rounded-xl border border-red-400/20 flex items-center justify-center gap-2">
                  <AlertCircle size={16} />
                  <span className="break-words">{error}</span>
                </div>
              )}

              <div className="text-[11px] text-slate-500 flex items-center justify-center gap-4">
                <a className="hover:text-slate-300" href="/privacy">Privacy</a>
                <a className="hover:text-slate-300" href="/terms">Terms</a>
                <a className="hover:text-slate-300" href={`mailto:${CONTACT_EMAIL}?subject=LingoLive%20Contact`}>Contact</a>
              </div>
            </div>
          </div>
        </main>

        {/* SETTINGS MODAL (simple) */}
        {settingsOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => setSettingsOpen(false)}
          >
            <div
              className="w-full max-w-md bg-slate-950 border border-white/10 rounded-2xl shadow-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="font-black text-lg">Settings</div>
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="p-2 rounded-xl hover:bg-white/5 border border-white/10"
                >
                  ✕
                </button>
              </div>

              <div className="text-sm text-slate-300 space-y-2">
                <div className="text-slate-400 text-xs">
                  For best security in production, Google recommends using Ephemeral Tokens instead of exposing API keys in the browser.
                </div>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <a href="/privacy" className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10">
                    Privacy
                  </a>
                  <a href="/terms" className="text-center text-xs font-black px-3 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-white/10">
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

              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-black text-xs"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
