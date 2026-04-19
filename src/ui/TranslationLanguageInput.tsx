import { TextAttributes } from '@opentui/core';
import { useTheme } from './useTheme';

const KNOWN_LANGUAGES: Record<string, string> = {
  en: 'English',
  vi: 'Vietnamese',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  zh: 'Chinese',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  tr: 'Turkish',
  pl: 'Polish',
  nl: 'Dutch',
  sv: 'Swedish',
  id: 'Indonesian',
  uk: 'Ukrainian',
};

export interface TranslationLanguageInputProps {
  visible: boolean;
  value: string;
  currentLang: string | null;
  onInput: (value: string) => void;
}

export function TranslationLanguageInput({
  visible,
  value,
  currentLang,
  onInput,
}: TranslationLanguageInputProps) {
  const t = useTheme();
  if (!visible) return null;

  const trimmed = value.trim().toLowerCase();
  const matchedName = KNOWN_LANGUAGES[trimmed];
  const valid = trimmed.length >= 2;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={44}
        height={8}
        border
        borderStyle="double"
        borderColor={valid && matchedName ? t.accent : trimmed.length > 0 ? t.yellow : t.dim}
        backgroundColor={t.bg}
        title="Translation Language"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap={1}
      >
        <text fg={t.dim}>
          Current:{' '}
          {currentLang ? `${currentLang} (${KNOWN_LANGUAGES[currentLang] ?? 'unknown'})` : 'none'}
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={t.fg}>Language: </text>
          <input focused={true} placeholder="en, vi, ja, ko..." value={value} onInput={onInput} />
        </box>
        <text fg={matchedName ? t.accent : t.dim} attributes={TextAttributes.DIM}>
          {matchedName
            ? `→ ${matchedName}`
            : trimmed.length > 0
              ? `2-letter code (e.g. en, vi, ja)`
              : 'Enter a language code'}
        </text>
      </box>
    </box>
  );
}
