import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Where a paper's full-text translation stands. */
export type TranslationStatus = {
  state: 'done' | 'translating' | 'waiting' | 'paused' | 'failed';
  /** 0–100 while translating. */
  progress: number;
  /** Waiting in this device's queue: how many papers go first, the running one included. */
  ahead?: number;
  /** Paused or failed: why, in the user's words. */
  reason?: string;
  /** Paused: seconds until it tries again by itself. */
  resumeIn?: number;
};
export type TranslationEvent = {
  projectId: string;
  fingerprint: string;
  status: TranslationStatus;
};

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('全文翻译只能在 Capsio 桌面应用中使用。'));
  return invoke<T>(name, args);
}

/**
 * BabelDOC full-text translation. It runs in the background by itself; opening a paper
 * in translation only moves that paper to the front.
 */
export const translator = {
  status: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_status', { projectId, paperId }),
  open: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_open', { projectId, paperId }),
  /** Translates a finished paper again, next; the old translation returns if that fails. */
  retranslate: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_retranslate', { projectId, paperId }),
  pdf: async (projectId: string, paperId: string) =>
    new Uint8Array(await command<ArrayBuffer>('translation_pdf', { projectId, paperId })),
  /** Ends a pause now, after what stopped it was fixed. */
  resume: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_resume', { projectId, paperId }),
  /** Saves a copy of the translated PDF where the user picks; false when they cancel. */
  save: (projectId: string, paperId: string, name: string) =>
    command<boolean>('translation_save', { projectId, paperId, name }),
  /** Shows the translated PDF in the system file manager. */
  reveal: (projectId: string, paperId: string) =>
    command<void>('translation_reveal', { projectId, paperId }),
  events: (callback: (event: TranslationEvent) => void) =>
    isTauri()
      ? listen<TranslationEvent>('translation-progress', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
export type Translator = typeof translator;
