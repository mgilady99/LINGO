export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export type TranscriptionRole = 'user' | 'model';

export type TranscriptionEntry = {
  role: TranscriptionRole;
  text: string;
  timestamp: Date;
};

export type Language = {
  code: string;
  name: string;
  flag: string;
};

export type PracticeScenario = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

export const SUPPORTED_LANGUAGES: Language[] = [
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
];

export const SCENARIOS: PracticeScenario[] = [
  {
    id: 'translator',
    title: 'Real-time Translator',
    description: 'Bi-directional translation between 2 languages.',
    icon: '🌐',
  },
  {
    id: 'casual',
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
