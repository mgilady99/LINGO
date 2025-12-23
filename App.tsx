import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Headphones, LogOut, AlertCircle, Settings as SettingsIcon, Mail } from 'lucide-react';
import {
  ConnectionStatus,
  SUPPORTED_LANGUAGES,
  SCENARIOS,
  Language,
  PracticeScenario,
} from './types';

// If your repo uses lowercase names:
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';
import Avatar from './components/avatar';
import AudioVisualizer from './components/audiovisualizer';

const CONTACT_EMAIL = 'callilcoil@gmail.com';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [nativeLang, setNativeLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [selectedScenario, setSelectedScenario] = useState<PracticeScenario>(SCENARIOS[1]);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Settings modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Audio / session refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Transcription chunk refs (kept for turnComplete timing, but NOT shown on UI)
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  // Fix stale mute in audio callback
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

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
    currentInputTranscriptionRef.current = '';
    currentOutputTranscriptionRef.current = '';
  }, []);

  useEffect(() => {
    return () => stopConversation();
  }, [stopConversation]);

  const startConversation = async () => {
    const apiKey = (import.meta as any).env?.VITE_API_KEY;

    if (!apiKey) {
      setError('Missing API Key. Please set VITE_API_KEY in Cloudflare Pages Environment Variables and redeploy.');
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
        systemInstruction = `You are a patient and friendly ${targetLang.name} tutor. User's native language is ${nativeLang.name}. Scenario: ${(selectedScenario as any).title}. Correct errors gently and keep the conversation flowing.`;
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);

            const inputCtx = inputAudioContextRef.current!;
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);

            processor.onaudioprocess = (e) => {
              sessionPromise.then((s) => {
                if (!isMutedRef.current && s) {
                  s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) });
                }
              });
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },

          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach((s) => {
                try {
                  s.stop();
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
              // Reset (we don't show transcript in UI)
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            const parts = m.serverContent?.modelTurn?.parts || [];
            const outputCtx = outputAudioContextRef.current!;
            for (const part of parts) {
              if (part.inlineData?.data) {
                setIsSpeaking(true);
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);

                const buffer = await decodeAudioData(decode(part.inlineData.data), outputCtx, 24000, 1);
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

  // Close settings on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-slate-950/80 backdrop-blur border-b border-white/5">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
              <Headphones className="text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-black">LingoLive</div>
              <div className="text-[11px] text-slate-400">Real-time voice practice</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-full bg-slate-900/60 border border-white/10">
              <AudioVisualizer isActive={status === ConnectionStatus.CONNECTED && !isSpeaking && !isMuted} color="#10b981" />
              <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
              <span className="text-[10px] font-black tracking-widest uppercase">{status}</span>
            </div>

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-xl bg-slate-900/60 border border-white/10 hover:bg-slate-900 transition"
              aria-label="Open settings"
              title="Settings"
            >
              <SettingsIcon size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Main: NO CHAT, NO SIDEBAR, NO SCROLL PUSH */}
      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Controls row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3 bg-slate-900/50 rounded-2xl border border-white/10">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Learn</div>
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

          <div className="p-3 bg-slate-900/50 rounded-2xl border border-white/10">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Native</div>
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

          <div className="p-3 bg-slate-900/50 rounded-2xl border border-white/10">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Mode</div>
            <select
              value={selectedScenario.id}
              onChange={(e) => setSelectedScenario(SCENARIOS.find((s) => s.id === e.target.value)!)}
              disabled={status !== ConnectionStatus.DISCONNECTED}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xs focus:ring-2 focus:ring-indigo-500 outline-none"
            >
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s as any).title}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Start button ALWAYS above avatar */}
        <section className="mt-6">
          {error && (
            <div className="mb-4 text-red-400 text-xs font-bold bg-red-400/10 px-4 py-3 rounded-xl border border-red-400/20 flex items-center gap-2">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <div className="flex flex-col items-center gap-4">
            {status === ConnectionStatus.CONNECTED ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
                  className={`px-5 py-4 rounded-2xl border-2 transition-all shadow-xl font-black flex items-center gap-2 ${
                    isMuted ? 'bg-red-500 border-red-400' : 'bg-slate-900 border-slate-700 hover:border-indigo-500'
                  }`}
                >
                  {isMuted ? <MicOff /> : <Mic />} {isMuted ? 'MIC OFF' : 'MIC ON'}
                </button>

                <button
                  onClick={stopConversation}
                  className="bg-red-600 px-6 py-4 rounded-2xl font-black flex items-center gap-2 hover:bg-red-700 transition-colors shadow-xl shadow-red-900/20"
                >
                  <LogOut /> EXIT
                </button>
              </div>
            ) : (
              <button
                onClick={startConversation}
                disabled={status === ConnectionStatus.CONNECTING}
                className="w-full sm:w-auto bg-indigo-600 px-8 py-5 rounded-3xl font-black flex items-center justify-center gap-3 text-lg shadow-2xl shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Mic size={26} />
                {status === ConnectionStatus.CONNECTING ? 'CONNECTING...' : 'START LIVE SESSION'}
              </button>
            )}

            {/* Avatar 20% smaller, always under button */}
            <div className="w-full flex flex-col items-center">
              <div className="scale-[0.8] origin-top">
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

              <div className="mt-3 text-center">
                <div className="text-2xl font-black text-white">
                  {status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'Gemini is speaking' : 'Listening...') : (selectedScenario as any).title}
                </div>
                <p className="text-slate-500 text-sm max-w-xl mx-auto">{(selectedScenario as any).description}</p>
              </div>

              {(isSpeaking || (status === ConnectionStatus.CONNECTED && !isMuted)) && (
                <div className="mt-4 h-10 flex items-center justify-center">
                  <AudioVisualizer isActive={true} color={isSpeaking ? '#6366f1' : '#10b981'} />
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Settings modal */}
      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md bg-slate-950 border border-white/10 rounded-3xl shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="font-black text-lg">Settings</div>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10 hover:bg-slate-800"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <a
                href="/privacy"
                className="block w-full px-4 py-3 rounded-2xl bg-slate-900/60 border border-white/10 hover:bg-slate-900 transition"
              >
                Privacy Policy
              </a>
              <a
                href="/terms"
                className="block w-full px-4 py-3 rounded-2xl bg-slate-900/60 border border-white/10 hover:bg-slate-900 transition"
              >
                Terms of Service
              </a>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="block w-full px-4 py-3 rounded-2xl bg-slate-900/60 border border-white/10 hover:bg-slate-900 transition flex items-center gap-2"
              >
                <Mail size={16} /> Contact: {CONTACT_EMAIL}
              </a>

              <div className="pt-2 text-[12px] text-slate-400">
                Accessibility: keyboard-friendly. Press <span className="font-black">Esc</span> to close this window.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-white/5 bg-slate-950/60 text-slate-500 text-xs">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>© {new Date().getFullYear()} LingoLive</div>
          <div className="flex items-center gap-3">
            <a className="hover:text-slate-300" href="/privacy">Privacy</a>
            <a className="hover:text-slate-300" href="/terms">Terms</a>
            <a className="hover:text-slate-300" href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;

