

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en-US', name: 'English', flag: '🇺🇸' },
  { code: 'he-IL', name: 'Hebrew', flag: '🇮🇱' },
  { code: 'es-ES', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr-FR', name: 'French', flag: '🇫🇷' },
  { code: 'it-IT', name: 'Italian', flag: '🇮🇹' },
  { code: 'ru-RU', name: 'Russian', flag: '🇷🇺' },
];

export interface PracticeScenario {
  id: string;
  title: string;
  description: string;
  icon: string;
}

export const SCENARIOS: PracticeScenario[] = [
  { id: 'translator', title: 'Real-time Translator', description: 'Bi-directional translation between 2 languages.', icon: '🔄' },
  { id: 'casual', title: 'Casual Chat', description: 'Friendly conversation to build fluency.', icon: '💬' },
  { id: 'shadowing', title: 'Expert Tutor', description: 'Intensive practice with corrections.', icon: '🎯' },
];

// Define TranscriptionEntry interface for conversation history
export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
  correction?: string;
  translation?: string;
  timestamp: Date;
}