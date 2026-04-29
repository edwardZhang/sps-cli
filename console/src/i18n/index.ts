import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import enChat from './resources/en/chat.json';
import enBoard from './resources/en/board.json';
import enProjects from './resources/en/projects.json';
import enWorkers from './resources/en/workers.json';
import enLogs from './resources/en/logs.json';
import enSkills from './resources/en/skills.json';
import enSystem from './resources/en/system.json';
import enCommon from './resources/en/common.json';
import zhChat from './resources/zh/chat.json';
import zhBoard from './resources/zh/board.json';
import zhProjects from './resources/zh/projects.json';
import zhWorkers from './resources/zh/workers.json';
import zhLogs from './resources/zh/logs.json';
import zhSkills from './resources/zh/skills.json';
import zhSystem from './resources/zh/system.json';
import zhCommon from './resources/zh/common.json';

export const NAMESPACES = [
  'common',
  'chat',
  'board',
  'projects',
  'workers',
  'logs',
  'skills',
  'system',
] as const;

export const SUPPORTED_LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const resources = {
  en: {
    common: enCommon,
    chat: enChat,
    board: enBoard,
    projects: enProjects,
    workers: enWorkers,
    logs: enLogs,
    skills: enSkills,
    system: enSystem,
  },
  zh: {
    common: zhCommon,
    chat: zhChat,
    board: zhBoard,
    projects: zhProjects,
    workers: zhWorkers,
    logs: zhLogs,
    skills: zhSkills,
    system: zhSystem,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: NAMESPACES as unknown as string[],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'sps.locale',
      caches: ['localStorage'],
    },
    returnNull: false,
  });

export default i18n;
