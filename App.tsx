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

// ⚠️ If your actual file is ./services/audioService (camelCase), change the import back.
// Using lowercase because you said all file/folder names are lowercase:
import { decode, decodeAudioData, createPcmBlob } from './services/audioservice';

// ⚠️ Same here: if your files are Avatar.tsx / TranscriptItem.tsx / AudioVisualizer.tsx, adjust casing.
import Avatar from './components/avatar';
import TranscriptItem from './components/transcriptitem';
import AudioVisualizer from './components/audiovisualizer';

const App: React.FC = () => {
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

  // Refs to accumulate transcription chunks until turn completion
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  // ✅ Fix stale closure for mute inside audio processor
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Auto-scroll transcript
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, [stopConversation]);

  const startConversation = async () => {
    // ✅ Vite: only VITE_* env vars are exposed to the client bundle
    const apiKey =
      (import.meta as any).env?.VITE_API_KEY ||
      (import.meta as any).env?.API_KEY; // fallback (optional)

    // 🔎 TEMP DEBUG (remove later)
    console.log('MODE:', import.meta.env.MODE);
    console.log('Has VITE_API_KEY:', 'VITE_API_KEY' in import.meta.env);
    console.log('VITE_API_KEY value:', import.meta.env.VITE_API_KEY);

    if (!apiKey) {
      setError('Missing API Key. Set VITE_API_KEY in Vercel Environment Variables.');
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

