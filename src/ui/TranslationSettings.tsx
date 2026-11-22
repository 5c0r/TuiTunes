import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import type { Overlay, TranslationProviderId, TranslationSettingsField } from '../store/ui';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

/** Draft of the translation settings overlay, as validated and saved by App. */
export type TranslationSettingsOverlay = Extract<Overlay, { kind: 'translation-settings' }>;

export const TRANSLATION_PROVIDER_LABELS: Record<TranslationProviderId, string> = {
  none: 'None (native captions only)',
  libretranslate: 'LibreTranslate',
  lingva: 'Lingva',
  mymemory: 'MyMemory',
  deepl: 'DeepL',
};

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

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trimmed lowercase language code, or null for blank ("auto"). */
export function normalizeLanguageCode(value: string): string | null {
  const code = value.trim().toLowerCase();
  return code.length === 0 ? null : code;
}

/** Trimmed endpoint URL, or null for blank (provider default). */
export function normalizeEndpointUrl(value: string): string | null {
  const endpoint = value.trim();
  return endpoint.length === 0 ? null : endpoint;
}

/**
 * Actionable validation of the draft before Save or Test Connection. Returns
 * null when the draft is savable, otherwise a user-facing message naming the
 * offending field.
 */
export function validateTranslationSettings(draft: TranslationSettingsOverlay): string | null {
  if (draft.provider === 'none') {
    // 'none' stays useful for native-only translation: a target language is
    // optional but must still be a valid code when entered.
    if (
      draft.targetLanguage.trim().length > 0 &&
      !LANGUAGE_PATTERN.test(draft.targetLanguage.trim())
    ) {
      return 'Target must be a language code (e.g. en, vi)';
    }
  } else if (!LANGUAGE_PATTERN.test(draft.targetLanguage.trim())) {
    return 'Enter a target language code (e.g. en, vi)';
  }
  if (
    draft.sourceLanguage.trim().length > 0 &&
    !LANGUAGE_PATTERN.test(draft.sourceLanguage.trim())
  ) {
    return 'Source must be a language code (e.g. en) or blank for auto';
  }
  if (draft.provider === 'mymemory' && draft.sourceLanguage.trim().length === 0) {
    return 'MyMemory needs an explicit source language (e.g. en)';
  }
  const endpoint = draft.endpoint.trim();
  if (draft.provider === 'libretranslate') {
    if (endpoint.length === 0) {
      return 'LibreTranslate needs its server URL (e.g. http://127.0.0.1:5000)';
    }
    if (!isHttpUrl(endpoint)) return 'Endpoint must be an http(s) URL';
  }
  if (draft.provider === 'lingva') {
    // No implicit stock proxy: an explicit instance URL is required.
    if (endpoint.length === 0) return 'Lingva needs an explicit instance URL';
    if (!isHttpUrl(endpoint)) return 'Instance must be an http(s) URL';
  }
  return null;
}

export interface TranslationSettingsProps {
  overlay: TranslationSettingsOverlay;
  onChange: (overlay: Overlay) => void;
}

/** Draft keys the editable rows write into via their input. */
type TranslationDraftKey = 'targetLanguage' | 'sourceLanguage' | 'endpoint' | 'apiKey';

/**
 * Pure renderer for the translation settings form. All state lives in the
 * overlay; navigation, editing and submit keys are owned by the single App
 * keyboard dispatcher. This component registers no keyboard handlers.
 */
export function TranslationSettings({ overlay, onChange }: TranslationSettingsProps) {
  const { width } = useTerminalDimensions();
  const t = useTheme();
  const p = usePresentation();

  const endpointUsed = overlay.provider === 'libretranslate' || overlay.provider === 'lingva';
  const keyUsed = overlay.provider === 'deepl';
  const targetHint = KNOWN_LANGUAGES[overlay.targetLanguage.trim().toLowerCase()] ?? null;

  const label = (text: string, width = 16): string => text.padEnd(width);

  const marker = (field: TranslationSettingsField): string =>
    overlay.field === field ? `${p.icon('selected')} ` : '  ';

  const rowColor = (field: TranslationSettingsField, relevant: boolean): string =>
    overlay.field === field ? t.accent : relevant ? t.fg : t.dim;

  const textRow = (
    field: TranslationSettingsField,
    name: string,
    value: string,
    hint: string | null,
    relevant: boolean,
  ) => {
    if (overlay.field === field && overlay.editing) return null; // rendered as input below
    const suffix = overlay.field === field && hint ? ` ${p.text('·')} ${hint}` : '';
    return (
      <text fg={rowColor(field, relevant)} truncate>
        {marker(field)}
        {label(name)}
        {value || '-'}
        {suffix}
      </text>
    );
  };

  const inputRow = (
    field: TranslationSettingsField,
    key: TranslationDraftKey,
    name: string,
    value: string,
    placeholder: string,
  ) => (
    <box flexDirection="row" flexGrow={1}>
      <text fg={t.accent} truncate>
        {marker(field)}
        {label(name)}
      </text>
      <input
        focused={true}
        placeholder={placeholder}
        value={value}
        onInput={(value: string) => onChange({ ...overlay, [key]: value })}
      />
    </box>
  );

  const statusText = () => {
    switch (overlay.test.state) {
      case 'running':
        return (
          <text fg={t.yellow}>Testing {TRANSLATION_PROVIDER_LABELS[overlay.provider]}...</text>
        );
      case 'ok':
        return (
          <text fg={t.green} truncate>
            {p.icon('check')} {overlay.test.message}
          </text>
        );
      case 'error':
        return (
          <text fg={t.red} truncate>
            {p.icon('warning')} {overlay.test.message}
          </text>
        );
      default:
        return null;
    }
  };

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
        width={Math.min(62, Math.max(1, width - 2))}
        height={12 + (overlay.test.state === 'idle' ? 0 : 1) + (overlay.error ? 1 : 0)}
        border
        borderStyle="double"
        {...p.borderProps}
        borderColor={t.accent}
        backgroundColor={t.bg}
        title="Translation Settings"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        {overlay.field === 'provider' ? (
          <text fg={t.accent} attributes={TextAttributes.BOLD} truncate>
            {marker('provider')}
            {label('Provider')}
            {TRANSLATION_PROVIDER_LABELS[overlay.provider]}
            {` ${p.text('·')} left/right or Enter to change`}
          </text>
        ) : (
          <text fg={t.fg} truncate>
            {marker('provider')}
            {label('Provider')}
            {TRANSLATION_PROVIDER_LABELS[overlay.provider]}
          </text>
        )}
        {overlay.field === 'target' && overlay.editing
          ? inputRow(
              'target',
              'targetLanguage',
              'Target',
              overlay.targetLanguage,
              'en, vi, ja, ko...',
            )
          : textRow(
              'target',
              'Target',
              overlay.targetLanguage.trim().toLowerCase(),
              targetHint
                ? `${p.text('→')} ${targetHint}`
                : overlay.provider === 'none'
                  ? 'optional (native translation only)'
                  : '2-letter code (e.g. en, vi)',
              true,
            )}
        {overlay.field === 'source' && overlay.editing
          ? inputRow('source', 'sourceLanguage', 'Source', overlay.sourceLanguage, 'blank = auto')
          : textRow(
              'source',
              'Source',
              overlay.sourceLanguage.trim().toLowerCase() || 'auto',
              overlay.provider === 'mymemory'
                ? 'required by MyMemory (e.g. en)'
                : 'blank = auto-detect',
              overlay.provider !== 'none',
            )}
        {overlay.field === 'endpoint' && overlay.editing
          ? inputRow('endpoint', 'endpoint', 'Endpoint', overlay.endpoint, 'http://127.0.0.1:5000')
          : textRow(
              'endpoint',
              'Endpoint',
              overlay.endpoint,
              endpointUsed
                ? overlay.provider === 'libretranslate'
                  ? 'required: LibreTranslate server URL'
                  : 'required: Lingva instance URL (no default proxy)'
                : null,
              endpointUsed,
            )}
        {overlay.field === 'key' && overlay.editing
          ? inputRow('key', 'apiKey', 'DeepL key', overlay.apiKey, 'DeepL-Auth-Key')
          : textRow(
              'key',
              'DeepL key',
              overlay.keySet ? 'set (hidden)' : 'not set',
              keyUsed ? (overlay.keySet ? 'Enter to replace' : 'Enter to type key') : null,
              keyUsed,
            )}
        <text
          fg={overlay.field === 'test' ? t.accent : t.fg}
          attributes={overlay.field === 'test' ? TextAttributes.BOLD : 0}
          truncate
        >
          {marker('test')}
          {label('Test Connection')}
          {overlay.test.state === 'idle'
            ? ` ${p.text('·')} checks ${TRANSLATION_PROVIDER_LABELS[overlay.provider]}`
            : ''}
        </text>
        <text fg={overlay.field === 'save' ? t.accent : t.fg} truncate>
          {marker('save')}
          {label('Save')}
          {overlay.field === 'save' ? ` ${p.text('·')} write config` : ''}
        </text>
        <text fg={overlay.field === 'cancel' ? t.accent : t.fg} truncate>
          {marker('cancel')}
          Cancel (discard changes)
        </text>
        {statusText()}
        {overlay.error ? (
          <text fg={t.red} truncate>
            {p.icon('warning')} {overlay.error}
          </text>
        ) : null}
        <text fg={t.dim}>
          [{p.text('↑')}
          {p.text('↓')}] field [enter] edit/apply [{p.text('←')}
          {p.text('→')}] provider [esc] close
        </text>
      </box>
    </box>
  );
}
