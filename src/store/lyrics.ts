import { atom } from 'jotai';
import type { LyricsResult } from '../providers/lyrics';
import { configAtom } from './config';

export type TranscriptSelection = { kind: 'auto' } | { kind: 'custom'; url: string };
export interface LyricsDocument {
  mediaKey: string;
  sourceKey: string;
  contentHash: string;
  original: LyricsResult;
}
export const lyricsDocumentAtom = atom<LyricsDocument | null>(null);
export const lyricsTranslationAtom = atom<{
  documentKey: string;
  targetLang: string;
  engineKey: string;
  lines: string[];
} | null>(null);
export const lyricsErrorAtom = atom<string | null>(null);

/** Whether lyrics panel is visible. */
export const lyricsVisibleAtom = atom(false);

/** Current lyrics data, or null if not loaded/unavailable. */
export const lyricsDataAtom = atom<LyricsResult | null>((get) => {
  const document = get(lyricsDocumentAtom);
  if (!document) return null;
  const translation = get(lyricsTranslationAtom);
  if (
    !get(translationEnabledAtom) ||
    !translation ||
    translation.documentKey !== JSON.stringify([document.mediaKey, document.contentHash]) ||
    translation.targetLang !== (get(configAtom).translationLanguage || 'en')
  )
    return document.original;
  return {
    ...document.original,
    translatedTo: translation.targetLang,
    lines: document.original.lines.map((line, index) => ({
      ...line,
      translatedText: translation.lines[index],
    })),
  };
});

/** Loading state for lyrics fetch. */
export const lyricsLoadingAtom = atom(false);

/** Transcript source preference: 'auto' (default), or a custom SRT/VTT URL. */
export const transcriptSourceAtom = atom<TranscriptSelection>({ kind: 'auto' });

/** Whether lyrics translation is enabled. */
export const translationEnabledAtom = atom(false);

/** Loading state for translation fetch. */
export const translationLoadingAtom = atom(false);
